// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#ifndef CHROME_BROWSER_UI_VIEWS_BREEZER_PEEK_BREEZER_PEEK_H_
#define CHROME_BROWSER_UI_VIEWS_BREEZER_PEEK_BREEZER_PEEK_H_

#include <memory>

#include "ui/base/window_open_disposition.h"

class GURL;

namespace content {
class NavigationThrottleRegistry;
struct OpenURLParams;
class WebContents;
}  // namespace content

// Peek: links opened from the live tab of a Breezer favourite show in a live
// page card above the browser window instead of replacing the favourite or
// adding a tab. The card hosts a real WebContents (no iframe), so every site
// loads with its own security policy. Escape, the close button, or a click on
// the tinted backdrop destroys the page; Expand moves the same live
// WebContents into an ordinary foreground tab.
//
// Only tabs marked with SetSource() can open a peek. Breezer's sidebar marks
// the tabs bound to its favourites through breezerPrivate.setPeekSources().
namespace breezer_peek {

// Marks or clears `contents` as the live tab of a favourite. Clearing does not
// close a peek that is already open.
void SetSource(content::WebContents* contents, bool enabled);
bool IsSource(content::WebContents* contents);

// For BrowserWebContentsDelegate::AddNewContents(). When `source` is a marked
// tab and the request is a user-initiated foreground tab, takes
// `new_contents`, shows it in a peek, and returns it. Otherwise leaves
// `new_contents` untouched and returns nullptr.
content::WebContents* MaybeShowNewContents(
    content::WebContents* source,
    std::unique_ptr<content::WebContents>& new_contents,
    WindowOpenDisposition disposition,
    bool user_gesture);

// For BrowserWebContentsDelegate::OpenURLFromTab(). Shows a renderer-initiated
// foreground-tab link from a marked tab in a peek and returns the new
// contents, or returns nullptr to let the browser open it normally.
content::WebContents* MaybeShowURL(content::WebContents* source,
                                   const content::OpenURLParams& params);

// Adds the throttle that keeps a marked tab on its site: a user's link click
// in the tab's main frame to another site opens in a peek instead.
void MaybeCreateAndAddNavigationThrottle(
    content::NavigationThrottleRegistry& registry);

// Exposed for tests: the throttle's same-tab decision, without a navigation.
bool ShouldPeekSameTabNavigation(const GURL& current_url,
                                 const GURL& destination_url);

}  // namespace breezer_peek

#endif  // CHROME_BROWSER_UI_VIEWS_BREEZER_PEEK_BREEZER_PEEK_H_
