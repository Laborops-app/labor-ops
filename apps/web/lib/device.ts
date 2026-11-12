/** Which device and how LaborOps is opened (used by the install guides). */
export const isIos = () =>
  typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));
export const isStandalone = () =>
  typeof window !== 'undefined' && (matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true);

export const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
