# Investigation Board — Journal Notes

A companion to [Investigation Board](https://github.com/mordachai/investigation-board) (v5.9.0+, Foundry v14).

**Right-click any image you can see in a journal → _Photo Note from Image_.** It drops an Investigation
Board photo note in the middle of the scene you're viewing, using that image, captioned and linked
back to the journal page it came from.

Works on:

- image-type journal pages (caption = the page name, else its image caption);
- images embedded in text pages (caption = `<figcaption>`, else a meaningful `alt`, else the page name);
- "Show Players" image popouts (caption = the popout title, else its caption).

Anyone who can see the image can pin it. Players with Foundry's *Create Drawings* permission create the
note themselves, **no GM needed** (Investigation Board's own create actions currently always route players
through a connected GM — it checks the scene-creation permission instead of *Create Drawings*). Players
without *Create Drawings* fall back to Investigation Board's GM relay, so a GM must be connected for them.

The note is **sized to the image's shape**, so the whole picture shows: a tall phone screenshot makes
a tall polaroid, a landscape photo a wide one (Investigation Board's own photo notes are a fixed
225×290 and crop anything that doesn't fit). Extreme shapes are clamped to between 0.3 and 3 width:height.

Edit the caption afterwards like any other photo note.

## Install

Setup → Add-on Modules → Install Module → Manifest URL:

```
https://github.com/willisterman/investigation-board-journal-notes/releases/latest/download/module.json
```

Then enable it (and Investigation Board) in **Manage Modules**.

## API

```js
const api = game.modules.get("investigation-board-journal-notes").api;
await api.createPhotoNoteFromImage({ image, caption, linkedObject, x, y });
// Reshape an existing photo note (including one made by Investigation Board itself) to show its whole image:
await api.fitPhotoNoteToImage(canvas.drawings.controlled[0].document);
```

## Coupling

This imports Investigation Board's internal modules (`config.js`, `utils/helpers.js`,
`utils/socket-handler.js`, `utils/creation-utils.js`, `state.js`) and mirrors its photo-note create data.
If an Investigation Board update moves those files or changes the note schema, this needs an update.

MIT licence.
