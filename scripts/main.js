/**
 * Investigation Board — Journal Notes
 *
 * Companion to mordachai's Investigation Board. Adds a right-click "Photo Note from Image"
 * to every image a user can see in a journal (image pages, images embedded in text pages,
 * and "Show Players" image popouts), creating an Investigation Board photo note on the
 * scene they're viewing, linked back to the page it came from. Also takes over IB's own
 * Photo Note from Scene / Actor menu items so those notes are shaped to the whole image too.
 *
 * Note creation goes through Investigation Board's own collaborativeCreate(), so players
 * without DRAWING_CREATE get their note made by the GM's client exactly as IB's own
 * context-menu actions do. IB internals are imported from their served paths; the import
 * URL must match the one IB's main.js resolved, or we'd get a second module instance with
 * an uninitialised socket — getRoute() keeps them identical under a route prefix.
 */

const MODULE_ID = "investigation-board-journal-notes";
const IB_ID = "investigation-board";
const PLACEHOLDER = `modules/${IB_ID}/assets/placeholder.webp`;

/** Image selectors per host application. Scoped to rendered page content, not the TOC or header. */
const JOURNAL_IMAGE_SELECTOR = ".journal-entry-page img";
const POPOUT_IMAGE_SELECTOR = "img";

let ibModules = null;

async function loadIB() {
  if (ibModules) return ibModules;
  const path = p => foundry.utils.getRoute(`modules/${IB_ID}/scripts/${p}`);
  const [config, helpers, sockets, state, creation] = await Promise.all([
    import(path("config.js")),
    import(path("utils/helpers.js")),
    import(path("utils/socket-handler.js")),
    import(path("state.js")),
    import(path("utils/creation-utils.js")),
  ]);
  ibModules = { config, helpers, sockets, state, creation };
  return ibModules;
}

/* -------------------------------------------- */
/*  Reading the clicked image                   */
/* -------------------------------------------- */

/**
 * The image's stored path, not its resolved URL — notes persist the path and other clients
 * resolve it themselves. Returns null for data:/blob: sources, which can't be shared.
 */
function imagePathFromElement(img) {
  const raw = img.getAttribute("src") || img.dataset.src || "";
  if (!raw || /^(data|blob):/i.test(raw)) return null;
  try {
    const url = new URL(raw, window.location.href);
    if (url.origin === window.location.origin) {
      const route = foundry.utils.getRoute("");
      let p = decodeURIComponent(url.pathname);
      if (route !== "/" && p.startsWith(route)) p = p.slice(route.length);
      return p.replace(/^\/+/, "");
    }
  } catch (_) { /* fall through to raw */ }
  return raw;
}

function isFilenameLike(text, path) {
  if (!text) return true;
  const base = (path || "").split("/").pop()?.split("?")[0] ?? "";
  return text === base || /^[\w.-]+\.(png|jpe?g|webp|gif|avif|svg)$/i.test(text.trim());
}

/** The page an image belongs to, from the rendered page article or the sheet's current page. */
function pageFromElement(img, app) {
  const entry = app?.document;
  if (!(entry instanceof JournalEntry)) return null;
  const article = img.closest("[data-page-id]");
  const pageId = article?.dataset.pageId;
  return (pageId && entry.pages.get(pageId)) || null;
}

/**
 * Work out caption + link for an image. A polaroid wants a short label, so titles win over
 * captions (which tend to be sentences): image page → page name, then its caption; embedded
 * image → <figcaption>, a meaningful alt, then the page name; popout → title, then caption.
 */
function describeImage(img, app) {
  const path = imagePathFromElement(img);
  const page = pageFromElement(img, app);
  const figcaption = img.closest("figure")?.querySelector("figcaption")?.textContent?.trim();
  const alt = img.getAttribute("alt")?.trim();

  let caption = "";
  let linkTarget = null;

  if (page) {
    caption = page.type === "image"
      ? (page.name || page.image?.caption?.trim() || "")
      : (figcaption || (!isFilenameLike(alt, path) && alt) || page.name);
    linkTarget = page;
  } else if (app instanceof foundry.applications.apps.ImagePopout) {
    caption = app.title || app.options.caption?.trim() || figcaption || "";
    if (app.options.uuid) linkTarget = fromUuidSync(app.options.uuid, { strict: false });
  } else {
    caption = figcaption || (!isFilenameLike(alt, path) && alt) || app?.document?.name || "";
    linkTarget = app?.document ?? null;
  }

  const linkedObject = linkTarget?.uuid
    ? `@UUID[${linkTarget.uuid}]{${linkTarget.name ?? caption}}`
    : "";

  return { path, caption, linkedObject };
}

/* -------------------------------------------- */
/*  Note creation                               */
/* -------------------------------------------- */

/**
 * IB draws a photo note's picture into a window inset from the polaroid frame by these
 * fractions of the note's size, and cover-fits it (crops the overflow) — see the isPhoto
 * branch of IB's custom-drawing.js. Everything in the note scales with its shape, so sizing
 * the shape so the window matches the image's aspect shows the whole picture.
 */
const PHOTO_WINDOW_W = 1 - 0.13333;
const PHOTO_WINDOW_H = 1 - 0.30246;
/** Keep extreme panoramas / receipts from making a note a sliver. */
const MIN_RATIO = 0.3;
const MAX_RATIO = 3;

async function imageAspect(image) {
  try {
    const tex = await foundry.canvas.loadTexture(image);
    if (tex?.width && tex?.height) return tex.width / tex.height;
  } catch (_) { /* unreadable image: fall back to the default frame */ }
  return null;
}

/**
 * Note shape whose photo window has the image's aspect. Portrait images keep IB's default
 * width and grow taller; landscape images keep the default height and grow wider, so the
 * caption strip stays the size IB expects for its font.
 */
function photoShapeForAspect(ratio, base) {
  if (!ratio) return { ...base };
  const r = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  const defaultRatio = (base.width * PHOTO_WINDOW_W) / (base.height * PHOTO_WINDOW_H);
  if (r >= defaultRatio) {
    return { width: Math.round((r * base.height * PHOTO_WINDOW_H) / PHOTO_WINDOW_W), height: base.height };
  }
  return { width: base.width, height: Math.round((base.width * PHOTO_WINDOW_W) / (r * PHOTO_WINDOW_H)) };
}

/**
 * Build the Drawing create data for an IB photo note. Mirrors IB's buildNoteCreateData()
 * and createPhotoNoteFromItem() (not exported) — keep in step with IB's creation-utils.js.
 */
async function buildPhotoNoteData({ image, caption = "", linkedObject = "", x = null, y = null, extraFlags = {} }) {
  const { config, helpers, creation } = await loadIB();
  const { width, height } = photoShapeForAspect(await imageAspect(image), creation.getNoteDimensions("photo"));
  const scale = helpers.getEffectiveScale();

  if (x === null || y === null) {
    const centre = canvas.stage.pivot;
    x = centre.x - (width * scale) / 2;
    y = centre.y - (height * scale) / 2;
  }

  const text = caption.trim();
  return {
    type: "r",
    name: text || config.NOTE_TYPE_LABELS?.photo || "Photo Note",
    author: game.user.id,
    x, y,
    shape: { width, height },
    fillColor: "#ffffff",
    fillAlpha: 1,
    strokeColor: "#000000",
    strokeWidth: 0,
    strokeAlpha: 0,
    locked: false,
    flags: {
      [IB_ID]: {
        type: "photo",
        text,
        linkedObject,
        image: image || PLACEHOLDER,
        textColor: game.settings.get(IB_ID, "defaultInkColor") || "#000000",
        ...extraFlags,
      },
      core: { sheetClass: `${IB_ID}.CustomDrawingSheet` },
    },
  };
}

/**
 * Create the note directly when Foundry would allow it, so players don't need a GM online.
 * IB's collaborativeCreate() gates its direct path on scene.canUserModify(user, "create") — the
 * permission to create a *Scene* (ASSISTANT) — so every player falls through to its GM socket
 * relay even though Foundry only requires DRAWING_CREATE + being the drawing's author
 * (BaseDrawing #canCreate). We check the real rule and keep IB's relay as the fallback.
 * `ibCreation` is IB's marker that this is a tool creation, not a paste (see its preCreateDrawing).
 */
async function createDrawing(data, sockets) {
  const options = { skipAutoOpen: true, ibCreation: true };
  if (game.user.isGM || game.user.can("DRAWING_CREATE")) {
    try {
      return await canvas.scene.createEmbeddedDocuments("Drawing", [data], options);
    } catch (err) {
      console.warn(`${MODULE_ID} | direct create refused, falling back to the GM relay`, err);
    }
  }
  return sockets.collaborativeCreate(data, { skipAutoOpen: true });
}

async function createPhotoNoteFromImage(opts) {
  if (!canvas?.scene) {
    ui.notifications.error("Investigation Board: open a scene first — the note goes on the scene you're viewing.");
    return null;
  }
  const { sockets, state } = await loadIB();
  const data = await buildPhotoNoteData(opts);
  const created = await createDrawing(data, sockets);

  // Same settle-then-make-interactive fixup IB applies to its own notes.
  if (state.InvestigationBoardState?.isActive && created?.[0]) {
    setTimeout(() => {
      const drawing = canvas.drawings.get(created[0].id);
      if (drawing) {
        drawing.eventMode = "auto";
        drawing.interactiveChildren = true;
      }
    }, 250);
  }

  if (created?.length) ui.notifications.info(`Pinned "${data.name}" to the board.`);
  else ui.notifications.warn("Investigation Board: the note wasn't created — is a GM connected?");
  return created?.[0] ?? null;
}

/**
 * Reshape an existing photo note (ours or IB's own) so its window shows the whole image.
 * Keeps the note's current width as the scale, so a note the user has resized stays that size.
 * Returns the new shape, or null if the drawing isn't a photo note / the image won't load.
 */
async function fitPhotoNoteToImage(drawingDoc) {
  const flags = drawingDoc?.flags?.[IB_ID];
  if (flags?.type !== "photo") return null;
  const ratio = await imageAspect(flags.image || PLACEHOLDER);
  if (!ratio) return null;
  const { creation, sockets } = await loadIB();
  const base = creation.getNoteDimensions("photo");
  const width = drawingDoc.shape.width || base.width;
  const shape = photoShapeForAspect(ratio, { width, height: Math.round(width * base.height / base.width) });
  await sockets.collaborativeUpdate(drawingDoc.id, { shape }, drawingDoc.parent?.id);
  return shape;
}

/* -------------------------------------------- */
/*  Context menu wiring                         */
/* -------------------------------------------- */

const bound = new WeakSet();

function menuItems(app) {
  return [{
    label: "Photo Note from Image",
    icon: '<i class="fa-solid fa-camera-polaroid"></i>',
    visible: img => !!canvas?.scene && !!imagePathFromElement(img),
    onClick: async (event, img) => {
      const { path, caption, linkedObject } = describeImage(img, app);
      if (!path) return ui.notifications.warn("Investigation Board: this image has no shareable path.");
      await createPhotoNoteFromImage({ image: path, caption, linkedObject });
    },
  }];
}

/* -------------------------------------------- */
/*  Scenes                                      */
/* -------------------------------------------- */

const SCENE_ITEM_LABEL = "Photo Note from Scene";   // IB's own label — we take over its onClick

/** The document a directory / navigation context-menu entry stands for. */
function documentFromLi(li, collection) {
  const el = li instanceof HTMLElement ? li : li?.[0];
  const t = el?.closest?.("[data-uuid], [data-entry-id], [data-document-id], [data-scene-id]") ?? el;
  if (!t) return null;
  if (t.dataset.uuid) return fromUuidSync(t.dataset.uuid, { strict: false });
  return collection.get(t.dataset.entryId || t.dataset.documentId || t.dataset.sceneId) ?? null;
}

const sceneFromLi = li => documentFromLi(li, game.scenes);

/** Photo note of a scene's background (still or video), shaped to the image and linked to the scene. */
async function createPhotoNoteFromScene(scene) {
  const caption = scene.navName || scene.name || "Unknown Location";
  return createPhotoNoteFromImage({
    image: scene.background?.src || null,
    caption,
    linkedObject: `@UUID[${scene.uuid}]{${caption}}`,
  });
}

function onSceneContextOptions(app, options) {
  const onClick = async (event, li) => {
    const scene = sceneFromLi(li);
    if (scene) await createPhotoNoteFromScene(scene);
    else ui.notifications.warn("Investigation Board: couldn't work out which scene that was.");
  };
  const ibItem = options.find(o => o.label === SCENE_ITEM_LABEL || o.name === SCENE_ITEM_LABEL);
  if (ibItem) ibItem.onClick = onClick;
  else options.push({ label: SCENE_ITEM_LABEL, icon: '<i class="fa-solid fa-camera-polaroid"></i>', onClick });
}

/* -------------------------------------------- */
/*  Actors                                      */
/* -------------------------------------------- */

// IB's own labels — we take over their onClick, as for scenes.
const ACTOR_ITEM_LABEL = "Photo Note from Actor";
const UNKNOWN_ACTOR_ITEM_LABEL = "Unknown Photo Note from Actor";

/**
 * Photo note of an actor's portrait, shaped to the image and linked to the actor. Caption is
 * IB's own display name (its "character name key" setting, prototype token name by default);
 * an unknown note is captioned "???" and carries IB's `unknown` flag, as IB's own does.
 */
async function createPhotoNoteFromActor(actor, isUnknown = false) {
  const { helpers } = await loadIB();
  const caption = isUnknown ? "???" : helpers.getActorDisplayName(actor);
  return createPhotoNoteFromImage({
    image: actor.img || null,
    caption,
    linkedObject: `@UUID[${actor.uuid}]{${caption}}`,
    extraFlags: isUnknown ? { unknown: true } : {},
  });
}

/* -------------------------------------------- */
/*  What the players know about an actor        */
/* -------------------------------------------- */

/**
 * Per-actor knowledge, set by the GM from the actor's context menu:
 *   "name"  — players know the name, not the face. The actor's portrait and token art are swapped
 *             for SILHOUETTE (the real paths are kept in our flags), so the sidebar thumbnail and a
 *             Limited sheet show nothing; players can only pin the named note, with the silhouette.
 *   "face"  — players have seen them but don't know who they are. Real portrait; players can only
 *             pin IB's "???" note. ⚠ The actor's own name is visible in the sidebar, so give it a
 *             descriptive name ("The Man in the Grey Fleece") — this module doesn't rename actors.
 *   "known" — everything. Both notes, as IB has them.
 *   none    — hidden (ownership NONE). The flag is cleared and the portrait restored.
 * Revealing raises default ownership to Limited (never lowers anything above it). Moving towards
 * more knowledge upgrades every note already pinned for that actor: silhouettes become the face,
 * "???" captions become the name — on every scene, so the board updates under the players' hands.
 */
const SILHOUETTE = `modules/${MODULE_ID}/assets/silhouette.webp`;
const KNOWLEDGE = {
  name:  { label: "Players know: name only",  icon: "fa-solid fa-signature", knowsName: true,  knowsFace: false },
  face:  { label: "Players know: face only",  icon: "fa-solid fa-user-secret", knowsName: false, knowsFace: true },
  known: { label: "Players know: name and face", icon: "fa-solid fa-id-card", knowsName: true,  knowsFace: true },
};
const HIDE_LABEL = "Hide from players";

const knowledgeOf = actor => actor?.getFlag(MODULE_ID, "knowledge") ?? null;
const portraitOf = actor => actor?.getFlag(MODULE_ID, "portrait") || actor?.img;

/** Which of IB's two actor notes this user may make. The GM can always make both. */
function canPin(actor, isUnknown) {
  if (!actor || game.user.isGM) return true;
  const k = KNOWLEDGE[knowledgeOf(actor)];
  if (!k) return true;                       // no knowledge set: IB's behaviour (both notes)
  return isUnknown ? (k.knowsFace && !k.knowsName) : k.knowsName;
}

async function setKnowledge(actor, state) {
  const LIMITED = CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED;
  const stored = actor.getFlag(MODULE_ID, "portrait");
  const storedToken = actor.getFlag(MODULE_ID, "tokenSrc");
  const update = {};

  if (state === "name") {
    if (!stored) {
      update[`flags.${MODULE_ID}.portrait`] = actor.img;
      update[`flags.${MODULE_ID}.tokenSrc`] = actor.prototypeToken.texture.src;
    }
    update.img = SILHOUETTE;
    update["prototypeToken.texture.src"] = SILHOUETTE;
  } else if (stored) {
    update.img = stored;
    update["prototypeToken.texture.src"] = storedToken || stored;
    update[`flags.${MODULE_ID}.-=portrait`] = null;
    update[`flags.${MODULE_ID}.-=tokenSrc`] = null;
  }

  if (state) {
    update[`flags.${MODULE_ID}.knowledge`] = state;
    if ((actor.ownership.default ?? 0) < LIMITED) update["ownership.default"] = LIMITED;
  } else {
    update[`flags.${MODULE_ID}.-=knowledge`] = null;
    update["ownership.default"] = CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
  }

  await actor.update(update);
  const upgraded = state ? await upgradeNotesFor(actor) : 0;
  const what = state ? KNOWLEDGE[state].label.toLowerCase() : "hidden from players";
  ui.notifications.info(`${actor.name}: ${what}${upgraded ? ` — ${upgraded} pinned note${upgraded > 1 ? "s" : ""} updated` : ""}.`);
}

/**
 * Bring every photo note linked to this actor up to what the players now know. Only ever adds:
 * a silhouette becomes the portrait once the face is known, "???" becomes the name once the
 * name is. Notes made by IB itself are found the same way, by the actor UUID in linkedObject.
 */
async function upgradeNotesFor(actor) {
  const k = KNOWLEDGE[knowledgeOf(actor)];
  if (!k) return 0;
  const { helpers } = await loadIB();
  const name = helpers.getActorDisplayName(actor);
  const portrait = portraitOf(actor);
  const tag = `@UUID[${actor.uuid}]`;
  let count = 0;

  for (const scene of game.scenes) {
    const updates = [];
    for (const d of scene.drawings) {
      const f = d.flags?.[IB_ID];
      if (f?.type !== "photo" || !f.linkedObject?.includes(tag)) continue;
      const u = { _id: d.id };
      if (k.knowsFace && f.image === SILHOUETTE && portrait !== SILHOUETTE) u[`flags.${IB_ID}.image`] = portrait;
      if (k.knowsName && (f.unknown || f.text === "???")) {
        Object.assign(u, {
          name,
          [`flags.${IB_ID}.text`]: name,
          [`flags.${IB_ID}.linkedObject`]: `${tag}{${name}}`,
          [`flags.${IB_ID}.-=unknown`]: null,
        });
      }
      if (Object.keys(u).length > 1) updates.push(u);
    }
    if (updates.length) {
      await scene.updateEmbeddedDocuments("Drawing", updates);
      count += updates.length;
    }
  }
  return count;
}

function onActorContextOptions(app, options) {
  const actorOf = li => documentFromLi(li, game.actors);

  for (const [label, isUnknown] of [[ACTOR_ITEM_LABEL, false], [UNKNOWN_ACTOR_ITEM_LABEL, true]]) {
    const onClick = async (event, li) => {
      const actor = actorOf(li);
      if (!actor) return ui.notifications.warn("Investigation Board: couldn't work out which actor that was.");
      if (!canPin(actor, isUnknown)) return;
      await createPhotoNoteFromActor(actor, isUnknown);
    };
    const visible = li => canPin(actorOf(li), isUnknown);
    const ibItem = options.find(o => o.label === label || o.name === label);
    if (ibItem) Object.assign(ibItem, { onClick, visible });
    else options.push({ label, icon: '<i class="fa-solid fa-camera-polaroid"></i>', onClick, visible });
  }

  if (!game.user.isGM) return;
  for (const [state, k] of Object.entries(KNOWLEDGE)) {
    options.push({
      label: k.label,
      icon: `<i class="${k.icon}"></i>`,
      visible: li => knowledgeOf(actorOf(li)) !== state,
      onClick: async (event, li) => { const a = actorOf(li); if (a) await setKnowledge(a, state); },
    });
  }
  options.push({
    label: HIDE_LABEL,
    icon: '<i class="fa-solid fa-eye-slash"></i>',
    visible: li => !!knowledgeOf(actorOf(li)),
    onClick: async (event, li) => { const a = actorOf(li); if (a) await setKnowledge(a, null); },
  });
}

function attach(app, selector) {
  const el = app.element;
  if (!el || bound.has(el)) return;
  bound.add(el);
  new foundry.applications.ux.ContextMenu(el, selector, menuItems(app), { jQuery: false, fixed: true });
}

function register() {
  if (globalThis.__ibJournalNotesRegistered) return;
  globalThis.__ibJournalNotesRegistered = true;

  // renderJournalEntrySheet also fires for subclasses (Monk's etc. permitting).
  Hooks.on("renderJournalEntrySheet", app => attach(app, JOURNAL_IMAGE_SELECTOR));
  Hooks.on("renderImagePopout", app => attach(app, POPOUT_IMAGE_SELECTOR));

  Hooks.once("ready", () => {
    if (!game.modules.get(IB_ID)?.active) {
      if (game.user.isGM) ui.notifications.warn(`${MODULE_ID}: Investigation Board isn't active — Journal Notes does nothing without it.`);
      return;
    }
    // Registered at ready, i.e. after IB's top-level context-option hooks, so IB's
    // entries are already in the list when we look for them (one item, not two).
    Hooks.on("getSceneContextOptions", onSceneContextOptions);
    Hooks.on("getActorContextOptions", onActorContextOptions);

    const api = {
      createPhotoNoteFromImage, createPhotoNoteFromScene, createPhotoNoteFromActor,
      buildPhotoNoteData, describeImage, fitPhotoNoteToImage,
      setKnowledge, knowledgeOf, upgradeNotesFor, SILHOUETTE,
    };
    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = api;
    globalThis.IBJournalNotes = api;
  });
}

register();
