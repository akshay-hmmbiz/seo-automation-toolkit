/** Plain names for the tag types Google Tag Manager uses inside a container. */
export const TAG_LABELS = {
  __googtag: 'Google tag (GA4 / Ads base tag)',
  __gaawe: 'GA4 event',
  __gaawc: 'GA4 configuration (older style)',
  __ua: 'Universal Analytics (switched off by Google in 2023)',
  __ga: 'Classic Google Analytics (switched off long ago)',
  __opt: 'Google Optimize (shut down in 2023)',
  __awct: 'Google Ads conversion',
  __sp: 'Google Ads remarketing',
  __awud: 'Google Ads user-provided data',
  __gclidw: 'Google Ads conversion linker',
  __flc: 'Floodlight counter',
  __fls: 'Floodlight sales',
  __html: 'Custom HTML',
  __img: 'Custom image pixel',
  __zone: 'Zone (loads another container)',
  __baut: 'Microsoft Advertising (Bing) UET',
  __bzi: 'LinkedIn Insight',
  __hjtc: 'Hotjar',
  __pntr: 'Pinterest',
  __mf: 'Mouseflow',
  __cegg: 'Crazy Egg',
  __csm: 'comScore',
  __twitter_website_tag: 'X (Twitter) pixel',
  __cvt: 'Custom template tag',
};

/**
 * These are not tags somebody added. GTM creates them itself so that
 * triggers such as "link click" or "scroll depth" have something to listen with.
 */
export const HELPER_LABELS = {
  __cl: 'Click listener',
  __lcl: 'Link click listener',
  __fsl: 'Form submit listener',
  __sdl: 'Scroll depth listener',
  __tl: 'Timer listener',
  __evl: 'Element visibility listener',
  __ytl: 'YouTube video listener',
  __hl: 'History change listener',
  __jel: 'JavaScript error listener',
  __tg: 'Trigger group',
};

/** How to describe a variable whose value only exists in the visitor's browser. */
const VARIABLE_LABELS = {
  __v: 'data layer variable',
  __jsm: 'custom JavaScript variable',
  __j: 'JavaScript variable',
  __k: 'cookie',
  __u: 'URL variable',
  __e: 'event name variable',
  __aev: 'click or form variable',
  __d: 'page element variable',
  __r: 'random number variable',
  __f: 'referrer variable',
  __cvt: 'custom template variable',
};

/** Custom templates are named __cvt_<numbers>; treat them as one type. */
export function normaliseType(fn) {
  if (typeof fn !== 'string' || fn === '') return '__unknown';
  return fn.startsWith('__cvt_') ? '__cvt' : fn;
}

export function tagLabel(type) {
  return TAG_LABELS[type] || HELPER_LABELS[type] || `Other tag type (${type})`;
}

export function variableLabel(macro) {
  const type = normaliseType(macro && macro.function);
  const label = VARIABLE_LABELS[type] || `variable of type ${type}`;
  const name = macro && typeof macro.vtp_name === 'string' ? macro.vtp_name : '';
  return name ? `${label} "${name}"` : label;
}
