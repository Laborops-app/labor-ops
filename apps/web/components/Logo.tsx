import Image from 'next/image';

/** Full logo that swaps to a light-text version in dark mode (see .logo-light / .logo-dark in globals.css). */
export default function Logo({ width, className = '' }: { width: number; className?: string }) {
  const height = Math.round((width * 440) / 480);
  return (
    <>
      <Image src="/brand/logo-full.png" alt="LaborOps — run every shift with precision" width={width} height={height} priority className={`logo-light ${className}`} />
      <Image src="/brand/logo-full-dark.png" alt="" aria-hidden="true" width={width} height={height} priority className={`logo-dark ${className}`} />
    </>
  );
}
