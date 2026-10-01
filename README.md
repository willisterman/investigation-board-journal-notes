# Investigation Board — Journal Notes

A companion to [Investigation Board](https://github.com/mordachai/investigation-board) (v5.9.0+, Foundry v14).

**Right-click any image you can see in a journal → _Photo Note from Image_.** It drops an Investigation
Board photo note in the middle of the scene you're viewing, using that image, captioned and linked
back to the journal page it came from.

Works on:

- image-type journal pages (caption = the page name, else its image caption);
- images embedded in text pages (caption = `<figcaption>`, else a meaningful `alt`, else the page name);
- "Show Players" image popouts (caption = the popout title, else its caption).

Anyone who can see the image can pin it. Players without the *Create Drawings* permission get the note
created by the GM's client through Investigation Board's own socket — so a GM must be connected, as for
every other Investigation Board note.

Edit the caption afterwards like any other photo note.

## Install

Setup → Add-on Modules → Install Module → Manifest URL:

```
https://github.com/willisterman/investigation-board-journal-notes/releases/latest/download/module.json
```

Then enable it (and Investigation Board) in **Manage Modules**.

## API

`game.modules.get("investigation-board-journal-notes").api.createPhotoNoteFromImage({ image, caption, linkedObject, x, y })`

## Coupling

This imports Investigation Board's internal modules (`config.js`, `utils/helpers.js`,
`utils/socket-handler.js`, `utils/creation-utils.js`, `state.js`) and mirrors its photo-note create data.
If an Investigation Board update moves those files or changes the note schema, this needs an update.

MIT licence.
