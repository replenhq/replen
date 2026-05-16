export function IconSprite() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" style={{ display: "none" }} aria-hidden="true">
      <defs>
        <symbol id="i-star" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2.5l2.95 6 6.55.95-4.75 4.65 1.12 6.55L12 17.6 6.13 20.65 7.25 14.1 2.5 9.45 9.05 8.5z" />
        </symbol>
        <symbol id="i-star-fill" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2.5l2.95 6 6.55.95-4.75 4.65 1.12 6.55L12 17.6 6.13 20.65 7.25 14.1 2.5 9.45 9.05 8.5z" />
        </symbol>
        <symbol id="i-thumbs-up" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 11v9H3v-9zM7 11l4-7c1.5 0 2.5 1 2.5 2.5V10h5.5c1.1 0 2 .9 1.8 2l-1.3 6.5c-.2 1-1 1.5-2 1.5H7" />
        </symbol>
        <symbol id="i-thumbs-down" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 13V4H3v9zM7 13l4 7c1.5 0 2.5-1 2.5-2.5V14h5.5c1.1 0 2-.9 1.8-2L19.5 5.5c-.2-1-1-1.5-2-1.5H7" />
        </symbol>
        <symbol id="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 12.5l5 5L20 6.5" />
        </symbol>
        <symbol id="i-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </symbol>
        <symbol id="i-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12s3.5-7 9-7c2.2 0 4.1.9 5.6 2.1M21 12s-3.5 7-9 7c-2.2 0-4.1-.9-5.6-2.1M3 3l18 18" />
        </symbol>
        <symbol id="i-arrow-right" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </symbol>
        <symbol id="i-pencil" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 113 3L7 19l-4 1 1-4z" />
        </symbol>
        <symbol id="i-external" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 4h6v6" />
          <path d="M10 14L20 4" />
          <path d="M19 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h6" />
        </symbol>
      </defs>
    </svg>
  );
}

export function Icon({ name, size = 15 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}
