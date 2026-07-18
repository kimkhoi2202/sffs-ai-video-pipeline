/**
 * Fonts — the SAME faces the live site uses: Anton (display) + DM Sans (body),
 * loaded via @remotion/google-fonts (the site loads them from Google Fonts too,
 * so this is pixel-faithful). @remotion/google-fonts registers the delayRender
 * gating internally and is robust under multi-tab concurrent rendering (the
 * local-file FontFace path could hang mid-render). The vendored TTFs under
 * public/fonts remain as an offline fallback.
 */
import { loadFont as loadAntonFont } from "@remotion/google-fonts/Anton";
import { loadFont as loadDMSansFont } from "@remotion/google-fonts/DMSans";

const anton = loadAntonFont("normal", { weights: ["400"], subsets: ["latin"] });
const dmSans = loadDMSansFont("normal", { weights: ["400", "500", "700", "800"], subsets: ["latin"] });

export const ANTON = anton.fontFamily; // "Anton"
export const DM_SANS = dmSans.fontFamily; // "DM Sans"
