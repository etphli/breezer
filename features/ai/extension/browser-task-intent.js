const TAB_REQUESTS = [
  /^(?:how many|what|which) (?:browser |open )?tabs(?: (?:do )?i (?:currently )?have(?: open)?| have i got open| are (?:currently )?open)?$/,
  /^what are (?:all )?(?:my |the )?(?:open |browser )?tabs$/,
  /^(?:count|list|show(?: me)?|tell me) (?:all )?(?:my |the )?(?:(?:currently )?open |browser )?tabs(?: (?:i have|that are) open)?$/,
  /^(?:show(?: me)?|give me) (?:a )?list of (?:all )?(?:my |the )?(?:(?:currently )?open |browser )?tabs$/,
  /^(?:(?:show(?: me)?|check|what(?: is|'s)) )?(?:my |the )?(?:current |open )?tab (?:count|list)$/,
];

const MEMORY_SUBJECT = '(?:breezer|(?:my|this|the) (?:browser|tab|mac|pc|computer|device|system)|(?:my |the )?(?:open )?tabs)';
const MEMORY_REQUESTS = [
  /^how much (?:of my )?(?:ram|memory) (?:(?:do )?i have(?: left| free| available| total)?|is (?:available|free|left|(?:being )?used|in use))$/,
  new RegExp(`^how much (?:ram|memory) (?:(?:is|are|do|does) ${MEMORY_SUBJECT} (?:using|use|have)|${MEMORY_SUBJECT} (?:is|are) using)$`),
  new RegExp(`^how much (?:ram|memory) is (?:being )?used by ${MEMORY_SUBJECT}$`),
  /^(?:what(?: is|'s) |(?:what|which) (?:of my |browser )?tabs? (?:is |are )?)(?:uses?|using(?: up)?|eating(?: up)?|taking up|hogging|consuming) (?:all (?:of )?|most of |(?:the )?most |so much )?(?:my |the )?(?:ram|memory)$/,
  /^(?:(?:show(?: me)?|check|tell me|what(?: is|'s) my) )?(?:my |the )?(?:current )?(?:system |browser |tab )?(?:ram|memory) (?:usage|stats)(?: by tab)?$/,
  /^(?:(?:show(?: me)?|check|tell me|what(?: is|'s)) )?(?:my |the )?(?:available|free|total|used|installed) (?:system )?(?:ram|memory)$/,
  /^which of (?:my |the )?(?:open )?tabs? (?:is |are )?(?:us(?:e|ing)|tak(?:es?|ing) up|consum(?:es?|ing)) (?:the )?most (?:ram|memory)$/,
];

function asksAboutTabs(request) {
  const topic = request.replace(/ (?:in|across) (?:this window|(?:all |my )?(?:breezer|browser) windows|all (?:my )?windows|my (?:browser|current window)|breezer)$/, '');
  return TAB_REQUESTS.some(pattern => pattern.test(topic));
}

function asksForStats(request) {
  const parts = request.split(/,? and /).map(part => part
    .replace(/^(?:show(?: me)?|tell me) (?=(?:how much|how many|what|which) )/, '')
    .replace(/ (?:right now|currently|at the moment)$/, '')
    .replace(/ (?:compared to|vs\.?|versus) (?:my|the|this) (?:computer|system|mac|pc|browser)$/, ''));
  const startsWithTabs = asksAboutTabs(parts[0]);
  return parts.every((part, index) => {
    const memory = part.replace(/ on (?:(?:my|this) (?:mac|pc|computer|device|system)|windows|macos)$/, '');
    return asksAboutTabs(part) || MEMORY_REQUESTS.some(pattern => pattern.test(memory)) ||
      (index === 1 && startsWithTabs && /^(?:how much (?:ram|memory) are they using|which (?:one|ones) (?:uses?|(?:is|are) using|takes? up) (?:the )?most (?:ram|memory))$/.test(part));
  });
}

const CREATE_DESIGN = '(?:make|create|design|draw|generate)';
const DESIGN_ACTION = `(?:${CREATE_DESIGN}|change|set|update|customize|apply)`;
const DESIGN = '(?:theme|background(?: colou?r)?|wallpaper|colou?r scheme)';
const BROWSER = '(?:breezer|browser|new tab(?: page)?)';
const IMAGE = '(?:this(?: (?:image|photo|picture|screenshot))?|(?:the )?(?:attached|uploaded) (?:image|photo|picture|screenshot))';
const STYLE_WORDS = String.raw`(?:(?!(?:and|on|about|for|of|to|with)\b)[\w-]+ ){0,3}`;

const BROWSER_DESIGN = new RegExp(
  `^${DESIGN_ACTION} (?:me )?(?:a |an |my |the |this )?${STYLE_WORDS}` +
  `(?:${BROWSER}(?:'s)? ${DESIGN}|${DESIGN} for (?:my |the |this )?${BROWSER})` +
  `(?: (?:to|with|from|using|based on|inspired by|that|like) .+)?$`,
);
const GIVE_BROWSER_DESIGN = new RegExp(`^give (?:my |the |this )?${BROWSER} (?:a |an )?${STYLE_WORDS}${DESIGN}(?: with .+)?$`);
const THEME_DESCRIPTION = String.raw`(?:(?!(?:on|about|for|of|to|with)\b)[\w-]+ ){0,8}`;
const SHORT_THEME = new RegExp(`^(?:${CREATE_DESIGN} (?:me )?|give me |i'd like )(?:a|an) ${THEME_DESCRIPTION}theme(?: (?:with|that|like|inspired by|based on) .+)?$`);
const COLOR_WORD = '(?:dark|light|warm|cool|soft|muted|pastel|deep|bright|black|white|grey|gray|red|orange|yellow|green|blue|navy|teal|turquoise|cyan|pink|purple|violet|lavender|magenta|brown|beige|charcoal|gold|silver)';
const BROWSER_COLOR = new RegExp(`^make (?:my |the |this )?${BROWSER} ${COLOR_WORD}(?:[ -]${COLOR_WORD}){0,3}$`);
const PROJECT_DESIGN = /\b(?:(?:app|website|site|blog|game|react|vue|angular|shopify|wordpress) theme|(?:in|for|on) (?:[\w-]+ ){0,3}(?:app|website|site|blog|game|component|project|react|vue|angular|shopify|wordpress))\b/;
const IMAGE_DESIGN = new RegExp(
  `^(?:(?:${DESIGN_ACTION} (?:me )?(?:a |an |my |the )?(?:${DESIGN}|palette)|theme) (?:from|based on|using) ${IMAGE}|` +
  `(?:use|set) ${IMAGE} as (?:my |the )?(?:${BROWSER} )?${DESIGN}(?: and ${CREATE_DESIGN} a theme from it)?|` +
  `turn ${IMAGE} into (?:a |an |my )?(?:${BROWSER} )?${DESIGN})$`,
);
const THEME_REVISION = /^(?:make it (?:a (?:little|bit) |slightly )?(?:darker|lighter|brighter|warmer|cooler)|(?:change|set) (?:the )?(?:background(?: colou?r)?|wallpaper|theme colou?r) to (?!.*\b(?:in|for|on) (?:my|our|the|this|a|an) ).+)$/;

// Viewing, linking or reusing an image that already exists is an ordinary chat
// request. Generation would send only these words and return unrelated art.
const EXISTING_IMAGE = /https?:\/\/|\b(?:on|from|in|of) (?:this|the current|my current) (?:web ?)?(?:page|tab|site|article|screen|screenshot|source)\b|\b(?:found|taken|sourced) (?:on|from) (?:the )?(?:web|internet)\b|\bfrom (?:the internet|google(?: images)?|wikipedia|wikimedia(?: commons)?)\b/;

export function detectBrowserTask(text, context = {}) {
  if (typeof text !== 'string' || /[`{}]/.test(text)) return '';
  const request = text.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ')
    .replace(/^(?:(?:please|(?:can|could|would|will) you) )+/, '')
    .replace(/[.!?]+$/, '').replace(/,? please$/, '');

  const direct = request.replace(/^(?:use (?:your |the )?browser tools? to |run )/, '');
  if (asksForStats(direct) || /^(?:browser_stats|(?:get|check|show(?: me)?) (?:my |the )?browser stats|(?:check|tell me) how much (?:ram|memory) (?:breezer|(?:my|the|this) browser) (?:uses|is using))$/.test(direct)) return 'stats';
  if (/^(?:restore|bring back|go back to|revert to) (?:my |the )?(?:previous|last) (?:look|appearance|theme|browser theme)$/.test(direct)
      || /^undo (?:my |the )?(?:last |previous )?(?:browser )?theme(?: change)?$/.test(direct)) return 'restore';
  if (context.allowImage && !EXISTING_IMAGE.test(direct) && /^(?:create|generate|draw|make) (?:me )?(?:an? )?(?:image|illustration|picture|poster) (?:of|showing|depicting|that) .+$/i.test(direct)) return 'image';
  if (PROJECT_DESIGN.test(request)) return '';
  if (SHORT_THEME.test(direct) || BROWSER_DESIGN.test(direct) || GIVE_BROWSER_DESIGN.test(direct) || BROWSER_COLOR.test(direct) ||
      /^(?:make|style|design) (?:my |the |this )?(?:browser|breezer) (?:look like |look as if |with the look of )\S.{0,250}$/.test(direct) ||
      (IMAGE_DESIGN.test(direct) && context.hasImage) || (THEME_REVISION.test(direct) && context.hasTheme)) return 'theme';
  return '';
}
