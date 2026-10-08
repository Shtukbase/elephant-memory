/**
 * THE BROWSER HALF'S STYLE: one sheet, on the harness's own `--dsw-*` tokens
 * and the content font sizes it publishes, so it follows the theme and the
 * font-size setting. Every class starts with `mem-`.
 */

const STYLE_TAG = 'data-plugin-css';

const STYLES = `
.mem-tool{display:flex;flex-direction:column}
.mem-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}
.mem-summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:auto;overflow:hidden}
.mem-tool[data-state=error] .mem-summary{color:var(--dsw-alias-state-error-primary)}
.mem-body{flex-direction:column;display:flex;margin:4px 0 4px 4px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);padding:12px 16px;max-height:220px;overflow-y:auto}
.mem-words{white-space:pre-wrap;word-break:break-word;min-width:0;color:var(--dsw-alias-label-secondary)}
.mem-hidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}

.mem-history{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}
.mem-bar{display:flex;flex-direction:column;gap:8px;padding:12px 14px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none}
.mem-headline{display:flex;align-items:center;gap:8px;min-width:0}
.mem-place{flex:1;min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:14px}
.mem-pick{max-width:50%;min-width:0;font:inherit;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:2px 6px}
.mem-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;background:none;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none}
.mem-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mem-search{display:flex}
.mem-search input{flex:1;min-width:0;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:4px 8px}
.mem-search input:focus-visible,.mem-pick:focus-visible,.mem-icon:focus-visible,.mem-more:focus-visible,.mem-line-press:focus-visible,.mem-hit-press:focus-visible,.mem-segment:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.mem-segments{display:flex;gap:2px}
.mem-segment{font:inherit;padding:2px 10px;border:none;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.mem-segment[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mem-scroll{flex:1;min-height:0;overflow-y:auto;padding:4px 14px 16px}
.mem-day{position:sticky;top:0;z-index:1;padding:10px 0 4px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600}
.mem-chat{padding:6px 0 2px;color:var(--dsw-alias-label-caption);font-size:12px}
.mem-turn{padding:6px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.mem-time{color:var(--dsw-alias-label-caption);font-size:11px}
.mem-entry{margin-top:4px}
.mem-who{color:var(--dsw-alias-label-caption);font-size:11px;margin-right:6px}
.mem-text{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.mem-entry[data-kind=user] .mem-text{color:var(--dsw-alias-label-primary)}
.mem-entry[data-kind=trace] .mem-text,.mem-entry[data-kind=work] .mem-text{color:var(--dsw-alias-label-tertiary)}
.mem-clamp{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
.mem-more{font:inherit;font-size:11px;border:none;background:none;padding:0;color:var(--dsw-alias-label-tertiary);cursor:pointer;text-decoration:underline 1px dotted;text-underline-offset:3px}
.mem-quiet{padding:20px 0;color:var(--dsw-alias-label-tertiary)}
.mem-error{padding:8px 0;color:var(--dsw-alias-state-error-primary)}
.mem-lines{list-style:none;margin:0;padding:0}
.mem-lines .mem-lines{margin-left:14px;border-left:.5px solid var(--dsw-alias-border-l2);padding-left:8px}
.mem-line-press,.mem-hit-press{display:block;width:100%;text-align:left;font:inherit;color:var(--dsw-alias-label-secondary);background:none;border:none;border-radius:var(--dsw-radius-sm);padding:4px 6px;cursor:pointer}
.mem-line-press:hover,.mem-hit-press:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mem-line-mark{display:inline-block;width:12px;color:var(--dsw-alias-label-caption)}
.mem-said{margin:2px 0 8px 14px;padding:6px 10px;border-left:2px solid var(--dsw-alias-border-l3)}
.mem-where{color:var(--dsw-alias-label-caption);font-size:11px;margin-bottom:2px}
.mem-lit{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(77,107,254,.18));color:inherit;border-radius:2px}
`;

/** Add the sheet once. */
function installStyles() {
  if (typeof document === 'undefined') return;
  const tagId = `${PACKAGE_ID}/styles`;
  if (document.querySelector(`style[${STYLE_TAG}=${JSON.stringify(tagId)}]`) !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = PACKAGE_ID;
  tag.dataset.pluginCss = tagId;
  tag.textContent = STYLES;
  document.head.appendChild(tag);
}
