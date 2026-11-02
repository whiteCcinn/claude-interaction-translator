# Historical architecture artwork

- `principle.png`: original architecture illustration.
- `principle.svg`: scalable version with embedded fonts.
- `principle.excalidraw`: editable diagram.
- `principle.spec.json`: source-grounded layout and content specification.

These inherited diagrams retain their original attribution. They document the
initial API input-translation design, whose current entry point is
`plugins/interaction-translator/hooks/register.ts`. The diagram shows the
submission hook, protected fragments, external translation API, restoration and
validation, failure stop, and delivery to Claude with reply-language context.
The wait card is a UI note; it does not enter the model context.

Diagram content uses this repository's MIT license. Embedded Excalifont and
Noto Sans SC fonts use SIL Open Font License 1.1; the corresponding notices are
included here. The output was rendered as a static paper-style sketch.
