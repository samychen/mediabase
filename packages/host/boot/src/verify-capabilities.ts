// @mediabase/boot — capability verification at boot.
//
// A capability declares what it contributes (`ctx.capabilities.register`) and registers the
// real thing into `ctx.api` / `ctx.tools` / services. `verify()` reconciles the two, and the
// policy for a mismatch lives HERE: dev logs a warning, and `${prefix}STRICT_CAPABILITIES=1`
// (CI, packaging) refuses to serve.

import type { Context } from '@deepseek-ai/cordis'

/**
 * Report every capability, and in strict mode refuse a lying declaration.
 *
 * The manifest is the contract a composition (and a client) reads, so a declaration that
 * registers nothing is worse than a missing one: nothing fails, and the surface is not
 * there. Strict mode is how that becomes a boot failure instead of a support ticket.
 */
export function verifyComposedCapabilities(
  ctx: Context,
  strict: boolean,
  envPrefix: string,
): void {
  const reports = ctx.capabilities.verify()
  for (const report of reports) {
    if (report.ok) {
      ctx.log.debug(`能力 ${report.id}: 声明与注册一致`)
      continue
    }
    const detail = [
      report.missing.services.length > 0 ? `services=${report.missing.services.join(',')}` : '',
      report.missing.api.length > 0 ? `api=${report.missing.api.join(',')}` : '',
      report.missing.tools.length > 0 ? `tools=${report.missing.tools.join(',')}` : '',
    ].filter(Boolean).join(' ')
    ctx.log.warn(`能力 ${report.id}(${report.title})声明与实际不符: ${detail}`)
  }
  const broken = reports.filter((report) => !report.ok)
  if (strict && broken.length > 0) {
    throw new Error(
      `capabilities.verify() 失败(${broken.map((report) => report.id).join(', ')}):` +
      ` 能力的 manifest 声明了未注册的服务/方法/工具(${envPrefix}STRICT_CAPABILITIES=1 时启动即失败)`,
    )
  }
}
