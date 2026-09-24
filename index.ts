import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import { createLiveDependencies, registerPiLive } from "./src/live.ts";

export default function piLiveExtension(pi: ExtensionAPI): void {
  registerPiLive(pi, createLiveDependencies(truncateToWidth));
}
