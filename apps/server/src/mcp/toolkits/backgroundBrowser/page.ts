import { BotBrowserPage, type BotBrowserAction } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import * as NodeCrypto from "node:crypto";
import { BackgroundBrowser } from "./runtime.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";

const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
});
const decodeToolResult = Schema.decodeUnknownSync(ToolResult);
const decodePage = Schema.decodeUnknownSync(Schema.fromJsonString(BotBrowserPage));

/** Produces a view of the original DOM without running a second copy of its scripts. */
export function browserPageScript(revision: string, knownRevision?: string) {
  return `(() => {
    const original = Array.from(document.querySelectorAll('*'));
    if (original.length > 20000) throw new Error('Page is too large to view');
    const clone = document.documentElement.cloneNode(true);
    const copies = [clone, ...Array.from(clone.querySelectorAll('*'))];
    const nodes = [];
    const signatures = [];
    const signature = node => JSON.stringify([node.tagName, node.id, node.getAttribute('href'), node.getAttribute('type'), node.disabled === true, (node.textContent || '').slice(0,512), node.value || '']);
    for (let i=0; i<original.length; i++) {
      const node=original[i], copy=copies[i];
      if (!copy) throw new Error('Page changed');
      copy.removeAttribute('data-j1-browser-node');
      if (node.matches('a,button,input,textarea,select,[role="button"],[onclick]')) {
        copy.setAttribute('data-j1-browser-node', String(nodes.length));
        nodes.push(node); signatures.push(signature(node));
      }
      if (node.tagName === 'INPUT') {
        const sensitive = node.type === 'password' || node.type === 'hidden';
        copy.setAttribute('value', sensitive ? '' : node.value);
        if (node.checked) copy.setAttribute('checked',''); else copy.removeAttribute('checked');
      }
      if (node.tagName === 'TEXTAREA') copy.textContent = node.value;
      if (node.tagName === 'OPTION') { if (node.selected) copy.setAttribute('selected',''); else copy.removeAttribute('selected'); }
    }
    for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
      for (const attr of Array.from(node.attributes)) if (/^on/i.test(attr.name) || ['srcdoc','autofocus','formaction'].includes(attr.name)) node.removeAttribute(attr.name);
    }
    for (const node of Array.from(clone.querySelectorAll('script,noscript,iframe,object,embed,base,meta'))) node.remove();
    const html = clone.outerHTML;
    if (html.length > 500000) throw new Error('Page is too large to view');
    const previous = globalThis.__j1BrowserView;
    const same = previous && previous.url === location.href && previous.html === html && previous.nodes.length === nodes.length && nodes.every((node,i)=>node===previous.nodes[i]);
    const revision = same ? previous.revision : ${JSON.stringify(revision)};
    globalThis.__j1BrowserView = { revision, nodes, signatures, html, url: location.href };
    return { revision, url: location.href, title: document.title.slice(0,512), html: revision === ${JSON.stringify(knownRevision ?? null)} ? '' : html };
  })()`;
}

export function browserActionScript(
  action: Exclude<BotBrowserAction, { type: "navigate" | "open" }>,
) {
  return `(() => {
    const action = ${JSON.stringify(action)};
    const view=globalThis.__j1BrowserView;
    const validate = index => {
      const node=view && view.nodes[index];
      if (!view || view.revision !== action.revision || !node || !node.isConnected || node.disabled) throw new Error('Page changed; refresh before trying again');
      const signature=JSON.stringify([node.tagName,node.id,node.getAttribute('href'),node.getAttribute('type'),node.disabled===true,(node.textContent||'').slice(0,512),node.value||'']);
      if(signature!==view.signatures[index])throw new Error('Page changed; refresh before trying again');
      return node;
    };
    const validateFill = node => {
      if (!['INPUT','TEXTAREA','SELECT'].includes(node.tagName) || node.readOnly || ['hidden','file','submit','button','checkbox','radio'].includes(node.type)) throw new Error('This control cannot be filled');
    };
    const fill = (node,value) => {node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));};
    const node=validate(action.node);
    if(action.type==='click') {
      const edits=(action.edits||[]).map(edit=>{const target=validate(edit.node);validateFill(target);return {target,value:edit.value};});
      for(const edit of edits) {if(!edit.target.isConnected)throw new Error('Page changed');fill(edit.target,edit.value);}
      if(!node.isConnected || node.disabled)throw new Error('Page changed');
      node.click(); return true;
    }
    validateFill(node);
    const edits=(action.edits||[]).map(edit=>{const target=validate(edit.node);validateFill(target);return {target,value:edit.value};});
    for(const edit of edits){if(!edit.target.isConnected)throw new Error('Page changed');fill(edit.target,edit.value);}
    if(!node.isConnected)throw new Error('Page changed');fill(node,action.value);
    return true;
  })()`;
}

const call = Effect.fn("BotBrowserPage.call")(function* (
  threadId: string,
  name: string,
  args: unknown,
) {
  const result = yield* (yield* BackgroundBrowser).requestForThread(threadId, "tools/call", {
    name,
    arguments: args,
  });
  return yield* Effect.try({
    try: () => {
      const decoded = decodeToolResult(result);
      if (decoded.isError)
        throw new Error("Browser operation failed. Refresh the page and try again.");
      return decoded;
    },
    catch: () => "Browser operation failed. Refresh the page and try again.",
  });
});

export const readBotBrowserPage = Effect.fn("BotBrowserPage.read")(function* (
  threadId: string,
  revision?: string,
) {
  const result = yield* call(threadId, "evaluate", {
    script: browserPageScript(NodeCrypto.randomBytes(16).toString("hex"), revision),
  });
  return yield* Effect.try({
    try: () => decodePage(result.content.find((item) => item.type === "text")?.text ?? ""),
    catch: () => "The browser could not produce a page view.",
  });
});

export const actOnBotBrowserPage = Effect.fn("BotBrowserPage.act")(function* (
  threadId: string,
  action: BotBrowserAction,
) {
  if (action.type === "open") {
    const browser = yield* BackgroundBrowser;
    const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
      Effect.mapError(() => "Could not load browser settings."),
    );
    yield* browser.openThread(threadId, settings.lightpandaExecutablePath);
  } else if (action.type === "navigate") {
    const url = yield* Effect.try({
      try: () => new URL(action.url),
      catch: () => "Enter a valid web address.",
    });
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return yield* Effect.fail("Only HTTP and HTTPS web addresses are supported.");
    yield* call(threadId, "goto", { url: url.toString(), waitUntil: "domcontentloaded" });
  } else yield* call(threadId, "evaluate", { script: browserActionScript(action) });
  return yield* readBotBrowserPage(threadId);
});
