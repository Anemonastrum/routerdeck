const paths = {
  plus: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4.5v15m7.5-7.5h-15"/>',
  back: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/>',
  chevronLeft: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m15 18-6-6 6-6"/>',
  search: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m21 21-4.35-4.35m0 0a7.5 7.5 0 1 0-10.607-10.607A7.5 7.5 0 0 0 16.65 16.65Z"/>',
  funnel: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.012L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.208 48.208 0 0 1 12 3Z"/>',
  chevron: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m9 18 6-6-6-6"/>',
  chevronDoubleRight: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m6.75 4.5 7.5 7.5-7.5 7.5m6-15 7.5 7.5-7.5 7.5"/>',
  client: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12A2.25 2.25 0 0 0 18.75 3h-13.5A2.25 2.25 0 0 0 3 5.25v9A2.25 2.25 0 0 0 5.25 16.5h13.5A2.25 2.25 0 0 0 21 14.25v-9Z"/>',
  save: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5A3.375 3.375 0 0 0 10.125 2.25H8.25m0 12.75 2.25 2.25 4.5-4.5M8.25 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125v-6.375M8.25 2.25V6a2.25 2.25 0 0 0 2.25 2.25h3"/>',
  bars: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"/>',
  pencil: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931ZM19.5 7.125 16.875 4.5M18 13.5V19.125A1.875 1.875 0 0 1 16.125 21H4.875A1.875 1.875 0 0 1 3 19.125V7.875A1.875 1.875 0 0 1 4.875 6H10.5"/>',
  check: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m4.5 12.75 6 6 9-13.5"/>',
  link: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13.5 6H16.5a4.5 4.5 0 0 1 0 9h-3m-3 0H7.5a4.5 4.5 0 0 1 0-9h3m-3 4.5h9"/>',
  trash: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673A2.25 2.25 0 0 1 15.916 21H8.084a2.25 2.25 0 0 1-2.244-1.327L4.772 5.79m14.456 0A48.108 48.108 0 0 0 15.75 5.25m-10.978.54c.34-.059.68-.114 1.022-.165m0 0A48.11 48.11 0 0 1 8.25 5.25m7.5 0V4.332c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201V5.25m7.5 0a48.667 48.667 0 0 0-7.5 0"/>',
  sparkles: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Zm8.445-7.188L18 9.75l-.258-1.034a3.375 3.375 0 0 0-2.458-2.458L14.25 6l1.034-.258a3.375 3.375 0 0 0 2.458-2.458L18 2.25l.258 1.034a3.375 3.375 0 0 0 2.458 2.458L21.75 6l-1.034.258a3.375 3.375 0 0 0-2.458 2.458Zm-1.365 11.852L16.5 21.75l-.393-1.182a3.375 3.375 0 0 0-2.14-2.14L12.75 18l1.182-.393a3.375 3.375 0 0 0 2.14-2.14L16.5 14.25l.393 1.182a3.375 3.375 0 0 0 2.14 2.14L18.25 18l-1.182.393a3.375 3.375 0 0 0-2.14 2.14Z"/>',
  external: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-6-6H21m0 0v9m0-9-10.5 10.5"/>',
};

export function heroIcon(name, extraClass = '') {
  return `<svg class="hero-icon ${extraClass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">${paths[name] || ''}</svg>`;
}
