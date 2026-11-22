import { TableKit } from "@tiptap/extension-table";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Italic, Link2, List, ListOrdered, Quote, Redo2, Table as TableIcon, Underline, Undo2 } from "lucide-react";
import type { ReactNode } from "react";

import { cx } from "./ui";

type Block = "p" | "h1" | "h2" | "h3" | "h4";
const BLOCKS: { value: Block; label: string }[] = [
  { value: "p", label: "Normal text" }, { value: "h1", label: "Title" }, { value: "h2", label: "Heading" },
  { value: "h3", label: "Subheading" }, { value: "h4", label: "Small heading" },
];

function Tool({ label, active = false, disabled = false, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className={cx("inline-flex size-8 items-center justify-center rounded-lg text-zinc-700 hover:bg-zinc-200 disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-700",
        active && "bg-blue-100 text-blue-800 dark:bg-blue-300/20 dark:text-blue-100")}>
      {children}
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: (["h1", "h2", "h3", "h4"] as const).find((h) => e.isActive("heading", { level: Number(h[1]) })) ?? "p",
      bold: e.isActive("bold"), italic: e.isActive("italic"), underline: e.isActive("underline"), bullets: e.isActive("bulletList"),
      numbers: e.isActive("orderedList"), quote: e.isActive("blockquote"), link: e.isActive("link"), table: e.isActive("table"),
      undo: e.can().undo(), redo: e.can().redo(),
    }),
  });
  const setBlock = (b: Block) => (b === "p" ? editor.chain().focus().setParagraph().run() : editor.chain().focus().setHeading({ level: Number(b[1]) as 1 | 2 | 3 | 4 }).run());
  const link = () => {
    if (s.link) { editor.chain().focus().unsetLink().run(); return; }
    const url = window.prompt("Link address (https://...)");
    if (url && /^https?:\/\//i.test(url.trim())) editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };
  const icon = "size-4";
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-1 border-b border-zinc-200 bg-zinc-50 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-800/80">
      <Tool label="Undo" disabled={!s.undo} onClick={() => editor.chain().focus().undo().run()}><Undo2 className={icon} /></Tool>
      <Tool label="Redo" disabled={!s.redo} onClick={() => editor.chain().focus().redo().run()}><Redo2 className={icon} /></Tool>
      <select aria-label="Text style" value={s.block} onChange={(e) => setBlock(e.target.value as Block)}
        className="mx-1 h-8 rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-800 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100">
        {BLOCKS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
      </select>
      <Tool label="Bold" active={s.bold} onClick={() => editor.chain().focus().toggleBold().run()}><Bold className={icon} /></Tool>
      <Tool label="Italic" active={s.italic} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className={icon} /></Tool>
      <Tool label="Underline" active={s.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline className={icon} /></Tool>
      <Tool label={s.link ? "Remove the link" : "Add a link"} active={s.link} onClick={link}><Link2 className={icon} /></Tool>
      <span aria-hidden className="mx-1 h-5 w-px bg-zinc-300 dark:bg-zinc-600" />
      <Tool label="Bulleted list" active={s.bullets} onClick={() => editor.chain().focus().toggleBulletList().run()}><List className={icon} /></Tool>
      <Tool label="Numbered list" active={s.numbers} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className={icon} /></Tool>
      <Tool label="Quote" active={s.quote} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote className={icon} /></Tool>
      <span aria-hidden className="mx-1 h-5 w-px bg-zinc-300 dark:bg-zinc-600" />
      <Tool label="Insert a table" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run()}><TableIcon className={icon} /></Tool>
      {s.table && (
        <span className="flex flex-wrap items-center gap-1 text-xs">
          {([["Add row", () => editor.chain().focus().addRowAfter().run()], ["Add column", () => editor.chain().focus().addColumnAfter().run()],
            ["Delete row", () => editor.chain().focus().deleteRow().run()], ["Delete column", () => editor.chain().focus().deleteColumn().run()],
            ["Delete table", () => editor.chain().focus().deleteTable().run()]] as [string, () => void][]).map(([label, run]) => (
            <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={run}
              className="rounded-lg px-2 py-1 text-zinc-700 hover:bg-zinc-200 dark:text-zinc-200 dark:hover:bg-zinc-700">{label}</button>
          ))}
        </span>
      )}
    </div>
  );
}

/** A document editor that works like a word processor: a page, a formatting bar, headings, lists, links and tables. */
export function DocEditor({ html, onChange, editable = true }: { html: string; onChange: (html: string) => void; editable?: boolean }) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3, 4] }, link: { openOnClick: false, autolink: true, protocols: ["https", "http", "mailto"] },
      code: false, codeBlock: false, strike: false }), TableKit.configure({ table: { resizable: false } })],
    content: html,
    editable,
    editorProps: { attributes: { class: "doc-page", "aria-label": "Document", role: "textbox", "aria-multiline": "true" } },
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
  });
  if (!editor) return null;
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-700">
      {editable && <Toolbar editor={editor} />}
      <div className="scroll-thin max-h-[62vh] overflow-y-auto bg-zinc-100 px-2 py-4 sm:px-6 dark:bg-zinc-950">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
