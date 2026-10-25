# Breezer translations

This directory contains the translation foundation for Breezer's browser interface. The initial translations come from Helium and retain their contributors' work and attribution. Some inherited strings still refer to Helium while Breezer branding is developed.

## Files

- `source.gen.json` is the generated list of translatable strings extracted from patches. Regenerate it with the translation tools.
- `languages.json` maps supported locale codes to language names.
- `translations/` contains per-language translation files.
- `owners.yml` records the inherited translation reviewers.

## Reviewing translations

Check the translation against its `source` text. Preserve `<ph>` placeholders and use a consistent level of formality. Keep product names such as Breezer, Helium, and Chromium unchanged when translating them.

Submit Breezer translation changes to the [Breezer repository](https://github.com/etphli/breezer). Upstream reviewer listings are attribution and reference. They do not imply those people maintain Breezer.

## Development

The inherited `devutils/i18n.py generate` command regenerates source strings. The `utils/i18n_apply.py` command applies translations to a prepared Chromium source tree. Run each command with `-h` for its options.

Changed product text needs matching translation entries. Check placeholders and rendered text before including a translation in a Breezer release.

## Translation format

Each translation file is a JSON array. Entries match `source.gen.json` by `name` and `source`, rather than by array position:

```json
{
  "name": "IDS_EXAMPLE_STRING",
  "source": "Original English text",
  "message": "Translated text",
  "feminine": "Feminine form when needed",
  "masculine": "Masculine form when needed"
}
```

Include `feminine` and `masculine` only when the translation differs by grammatical gender. The [original translation guide](../../../../docs/upstream-originals/translations.md) is preserved for reference.
