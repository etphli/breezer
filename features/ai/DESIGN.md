# Breezer assistant

The native side panel gives the page most of the window. The assistant reads the current page on request, keeps the page attached above the composer, and makes browser control a visible choice. Comet's current-page chip, conversation placement, and persistent stop control inform the interaction.

The palette is pearl `#f5f7f9`, paper `#ffffff`, ink `#182c31`, muted slate `#738388`, Breezer mint `#c8f2e8`, and active blue `#367af6`. Native system type uses 13 px for controls, 15 px for conversation, and 28 px for the greeting. Left alignment and generous vertical space keep the narrow panel readable.

```text
 Breezer                           +  profile

 What are we working on,
 Ethan?

 Summarize this page
 Find an answer here
 Help me do something

                       conversation scrolls
 [current page]                    [include]
 [Ask about this page…                    ]
 [control off]                     [send ↑]
 [provider / model ⌄]                 ⌘ K
```

The distinctive detail is the connection between the page and composer: a small mint page attachment becomes an explicit blue control status while the assistant acts. There are no decorative metrics, dashboard cards, or artificial sample conversations. Disconnected accounts and unavailable models remain visible as such. During control the page itself is framed by a slow blue wave that flows clockwise around the edges, with a Breezer pointer at each action and a Stop control. The wave is pre-rendered and moves only by compositor transform and opacity, ignores input, and holds still when reduced motion is requested.
