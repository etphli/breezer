# Update-page authoring template

Use with [the code map and page contract](../whats-new.md). Edit `features/ai/extension/whats-new.html` and its CSS; this file is an authoring recipe, not a second runtime page.

## New `1.x.0` edition

1. List the four or five finished user-visible changes and any known limitations.
2. Keep the existing cream page shell, header/actions and script hooks. Replace the previous edition's feature and patch content with this edition's changes.
3. Add an illustrated feature row for each change or closely related group. Use the pattern below with unique heading IDs and artwork that explains the actual behavior.
4. Set the published version during release preparation. Confirm the derived `RELEASE_PAGE_VERSION` is the new `1.x.0` value.
5. Run the static, opening-service and browser tests from `docs/whats-new.md`. Inspect desktop and narrow screenshots. Complete native release acceptance separately, without installing locally unless the user asks.

```html
<article class="feature" aria-labelledby="f-unique-change">
  <figure class="plate" aria-hidden="true">
    <!-- Local CSS shapes or an original inline SVG explaining the change. -->
  </figure>
  <div class="feature-copy">
    <h3 id="f-unique-change">What the user can now do</h3>
    <p>Describe the behavior and where to find it. Include a limitation if it affects use.</p>
  </div>
</article>
```

## Patch in the same `1.x` edition

Append a section using the live page's `.patch-notes` structure. Keep previous notes and reuse its illustrated row patterns. Use a unique heading ID, the exact patch label and concise descriptions of shipped changes. For example:

```html
<section class="patch-notes" aria-labelledby="patch-113-title">
  <p class="release">Update 1.1.3</p>
  <h2 id="patch-113-title">The change users will notice</h2>
  <div class="patch-lead">
    <figure class="plate patch-plate" aria-hidden="true">
      <svg class="art" viewBox="0 0 320 232" focusable="false">
        <!-- Original vector shapes explaining this change. -->
      </svg>
    </figure>
    <div class="patch-copy">
      <h3>Where the change appears</h3>
      <ul class="notes"><li>Describe the shipped behavior.</li></ul>
    </div>
  </div>
  <!-- Add a .patch-pair with .patch-group blocks for related smaller changes. -->
</section>
```

Keep `RELEASE_PAGE_VERSION` at `1.1.0` for this example. Verify that a reader who already saw the 1.1 edition does not get another automatic tab. Keep the stable `whats-new.html` URL.

Artwork should use the current palette and local vector/CSS primitives, remain understandable beside its text, and fit on narrow screens. Keep decorative SVGs outside the keyboard order. A diagram of a feature must not imply the feature passed a native test.
