// Inline stroke icons — the editor's iconography, hand-drawn on a 24 grid in
// the lucide idiom (stroke = currentColor, no fills except transport glyphs).
// Zero dependencies: the product ships no icon package, and every glyph is a
// few path commands here rather than a runtime import.

import type { ReactElement, SVGProps } from 'react'

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number
}

function Svg({ size = 14, children, ...rest }: IconProps & { children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconPlay = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M7 4v16l13-8z" fill="currentColor" stroke="none" /></Svg>
)
export const IconPause = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
  </Svg>
)
export const IconScissors = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.6" />
    <circle cx="6" cy="18" r="2.6" />
    <path d="M20 4L8.6 15.4M14.5 14.5L20 20M8.6 8.6L12 12" />
  </Svg>
)
export const IconPlus = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
)
export const IconMinus = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M5 12h14" /></Svg>
)
export const IconX = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M18 6L6 18M6 6l12 12" /></Svg>
)
export const IconChevronLeft = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M15 18l-6-6 6-6" /></Svg>
)
export const IconChevronRight = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M9 18l6-6-6-6" /></Svg>
)
export const IconUndo = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></Svg>
)
export const IconRedo = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></Svg>
)
export const IconCheck = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M20 6L9 17l-5-5" /></Svg>
)
export const IconUpload = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /><path d="M12 15V3M7 8l5-5 5 5" /></Svg>
)
export const IconDownload = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /><path d="M12 3v12M7 10l5 5 5-5" /></Svg>
)
export const IconInbox = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9a2 2 0 0 0-1.8-1.1H7.3a2 2 0 0 0-1.8 1.1z" />
  </Svg>
)
export const IconType = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M4 7V4h16v3M12 4v16M8 20h8" /></Svg>
)
export const IconFilm = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
    <path d="M2.5 9h19M2.5 15h19M7.5 4v16M16.5 4v16" />
  </Svg>
)
export const IconImage = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-4.5-4.5L5 21" />
  </Svg>
)
export const IconMusic = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></Svg>
)
export const IconCaptions = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <rect x="2" y="4" width="20" height="16" rx="3" />
    <path d="M10.5 10.8a2.6 2.6 0 1 0 0 2.4M17.5 10.8a2.6 2.6 0 1 0 0 2.4" />
  </Svg>
)
export const IconTrash = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M3 6h18M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
    <path d="M19 6l-1 13.1a2 2 0 0 1-2 1.9H8a2 2 0 0 1-2-1.9L5 6" />
  </Svg>
)
export const IconSparkles = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
  </Svg>
)
export const IconVolume = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M11 5L6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /></Svg>
)
export const IconVolumeOff = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M11 5L6 9H2v6h4l5 4z" /><path d="M22 9l-6 6M16 9l6 6" /></Svg>
)
export const IconEye = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z" /><circle cx="12" cy="12" r="3" /></Svg>
)
export const IconEyeOff = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M17.9 17.9A10.6 10.6 0 0 1 12 19.5C5.5 19.5 1.5 12 1.5 12a19 19 0 0 1 5.1-5.9" />
    <path d="M9.9 4.9A10.4 10.4 0 0 1 12 4.5c6.5 0 10.5 7.5 10.5 7.5a19.3 19.3 0 0 1-2.6 3.9" />
    <path d="M2 2l20 20" />
  </Svg>
)
export const IconActivity = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M22 12h-4l-3 8.5L9 3.5 6 12H2" /></Svg>
)
export const IconSave = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <path d="M17 21v-8H7v8M7 3v5h8" />
  </Svg>
)
