# @mediabase/shm

**共享内存帧环**(基于 `SharedArrayBuffer`):单生产者/单消费者、零拷贝读取、满环丢最旧。

## 为什么是"环"而不是"队列"

跟不上播放速度的观看者应当**丢帧**,而不是攒欠账 —— 这与 WS 推送通道的背压策略是同一条。
环把这个策略做成结构性的:生产者直接覆盖最旧的槽位并计数,而不是指望传输层发现"太慢了"。

## 它到底省掉了哪一次拷贝

生产者的字节落在**一块** `SharedArrayBuffer` 里,两端映射同一块内存:
读取方拿到的 `bytes` 是这块内存上的 `subarray` **视图**(`bytes.buffer === ring.buffer`),
因此读路径上**没有每帧分配、没有拷贝** —— 这正是「网络泵 ↔ 渲染」「Node 线程 ↔ 线程」
之间真正花钱的地方。

**它不省掉网络那次拷贝**:字节从 WS/HTTP 过来必须落在某个地方。它省掉的是落下来之后的一切。

**它也不是"跨进程把内存塞进浏览器"**:网页无法通过 WebSocket 收到 `SharedArrayBuffer`,
必须由**页面自己创建**(需要跨源隔离,见 `@mediabase/gateway` 的 `crossOriginIsolation`),
之后本环让页面内的各方共享帧而不拷贝。

## 用法

```ts
import { SharedRing, attachRing } from '@mediabase/shm'

// 一端创建(决定形状),另一端 attach —— buffer 本身就是"句柄",传递即共享,不序列化
const ring = SharedRing.create({ slots: 4, slotBytes: 4 * 1024 * 1024 })
worker.postMessage(ring.toTransferable())
const same = attachRing(ring.toTransferable())

ring.publish(frameBytes)      // 满环时覆盖最旧并返回 { seq, dropped }
const f = ring.acquire()      // 零拷贝视图;读完 release()
const newest = ring.latest()  // 只要最新一帧(监控/预览)
```

客户端侧已经有现成的接收器(`@mediabase/connection` 的 `openRingStream`):订阅一个通道,
每帧 publish 进环,UI 用 `latest()` 拿视图。

## 并发契约(调用方最容易踩的部分)

- **严格 SPSC**:一个生产者、一个消费者。多对多需要外部同步。
- `acquire()` 返回的视图**在下一次 `acquire()` 之前有效**。只有当消费者落后满一环
  (`slots`) 时生产者才会覆盖它 —— 此时丢帧计数已经变了;需要长期持有就 `takeCopy()`。
- `waitForData()` **会阻塞当前线程**:worker 里正确,UI 主线程上会卡住页面。
  主线程请轮询(`acquire()`/`latest()`),或把消费者放进 worker。
- 形状不一致会**报错而不是读错内存**:`attach()` 校验 `slots`/`slotBytes`/总长度/初始化标记。

## 状态与观测

`stats()` 一次给全:`published / pending / dropped / closed / slots / slotBytes / bytes` ——
UI 与 health 直接展示这个对象,不需要自己维护计数。
