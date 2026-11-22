import { createElement, type ReactNode } from "react";

const ALLOWED = new Set(["p", "b", "strong", "i", "em", "u", "ul", "ol", "li", "a", "br", "h3", "h4", "span", "div"]);

function build(node: Node, key: number): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const children = Array.from(el.childNodes).map((c, i) => build(c, i));
  if (!ALLOWED.has(tag)) return children;
  if (tag === "br") return createElement("br", { key });
  if (tag === "a") {
    const href = el.getAttribute("href") ?? "";
    return /^https?:\/\//i.test(href) ? createElement("a", { key, href, target: "_blank", rel: "noreferrer" }, ...children) : children;
  }
  return createElement(tag, { key }, ...children);
}

/** Stored HTML shown with a short list of tags and http(s) links only; everything else is dropped to its text. */
export function SafeHtml({ html, className }: { html: string; className?: string }) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return <div className={className}>{Array.from(doc.body.childNodes).map((n, i) => build(n, i))}</div>;
}
