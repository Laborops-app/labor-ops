import type { CSSProperties } from 'react';

/** Figma icon (downloaded SVG) drawn as a mask so it follows the text colour. */
export default function Ic({ n, className = '', size }: { n: string; className?: string; size?: number }) {
  const style = { '--ic': `url(/schedule/${n}.svg)`, ...(size ? { width: size, height: size } : {}) } as CSSProperties;
  return <i className={`ic ${className}`} style={style} aria-hidden="true" />;
}
