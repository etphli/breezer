// Copyright 2026 The Breezer Authors
#ifndef CHROME_BROWSER_EXTENSIONS_API_BREEZER_PRIVATE_RESEARCH_TEXT_H_
#define CHROME_BROWSER_EXTENSIONS_API_BREEZER_PRIVATE_RESEARCH_TEXT_H_

// Fixed read-only script. Never interpolate caller or model text here.
inline constexpr char16_t kBreezerResearchText[] = uR"research((() => {
  const mask = text => text
    .replace(/-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]*/g, '[redacted key]')
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,}|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
    .replace(/\b(password|secret|token|api[_ -]?key|authorization)\s*[:=]\s*\S+/gi, '$1: [redacted]');
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const text = [];
  let length = 0, nodes = 0, truncated = false;
  while (walker.nextNode()) {
    if (++nodes > 40000 || length >= 24000) { truncated = true; break; }
    const parent = walker.currentNode.parentElement;
    if (!parent || parent.closest('script,style,noscript,input,textarea,select,[contenteditable],[data-breezer-ai],[hidden],[aria-hidden="true"],iframe,object,embed,[autocomplete*="password"],[autocomplete*="cc-"],[autocomplete="one-time-code"],[name*="token" i],[id*="token" i],[name*="secret" i],[id*="secret" i],[name*="password" i],[id*="password" i]')) continue;
    if (!parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const raw = walker.currentNode.textContent;
    if (raw.length > 24000) truncated = true;
    const value = mask(raw.slice(0, 24001).replace(/\s+/g, ' ').trim());
    if (value) { text.push(value); length += value.length + 1; }
  }
  const value = text.join(' ');
  const captured = value.slice(0, 24000);
  return { text: captured, truncated: truncated || value.length > 24000, capturedCharacters: captured.length };
})())research";

#endif  // CHROME_BROWSER_EXTENSIONS_API_BREEZER_PRIVATE_RESEARCH_TEXT_H_
