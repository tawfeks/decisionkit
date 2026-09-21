// Thin drop-in: the whole adapter lives in decisionkit-pi-ext (single source).
// @earendil-works/pi-coding-agent and typebox are bundled/shimmed by pi's
// extension loader, so only decisionkit-core + the SDK need real node_modules here.
import decisionkitExtension from "decisionkit-pi-ext";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  decisionkitExtension(pi);
}
