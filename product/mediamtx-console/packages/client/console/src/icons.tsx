// Panel glyphs — inline SVG, currentColor, no icon dependency. Same recipe as
// the openvideo icon set.

import type { ReactElement, SVGProps } from 'react'

function svg(props: SVGProps<SVGSVGElement>, path: ReactElement): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {path}
    </svg>
  )
}

export const IconPlay = (p: SVGProps<SVGSVGElement>): ReactElement => svg(p, <polygon points="6 4 20 12 6 20 6 4" />)
export const IconStop = (p: SVGProps<SVGSVGElement>): ReactElement => svg(p, <rect x="6" y="6" width="12" height="12" rx="1" />)
export const IconPlus = (p: SVGProps<SVGSVGElement>): ReactElement => svg(p, <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>)
export const IconTrash = (p: SVGProps<SVGSVGElement>): ReactElement => svg(p, <><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></>)
export const IconKick = (p: SVGProps<SVGSVGElement>): ReactElement => svg(p, <><circle cx="12" cy="12" r="9" /><line x1="9" y1="9" x2="15" y2="15" /><line x1="15" y1="9" x2="9" y2="15" /></>)
export const IconTv = (p: SVGProps<SVGSVGElement>): ReactElement => svg(p, <><rect x="2" y="7" width="20" height="13" rx="2" /><polyline points="8 3 12 7 16 3" /></>)
