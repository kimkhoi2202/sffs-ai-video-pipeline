import { AbsoluteFill, Img, staticFile } from "remotion";
import { COLORS, hardDropShadow } from "../theme/brand";
import { Stage, titleStyle, BrandPill } from "./bits";

/**
 * SELF-CONTAINED thumbnail set for the intro post. Three on-brand stills, each
 * hand-framed for its ratio: 9:16 (1080x1920), 1:1 (1080x1080), 16:9
 * (1920x1080). Hook "CAN YOUR KID PASS?" + brain + the brand lockup. Rendered
 * via `remotion still` at a settled frame so the floating shapes have entered.
 */

const LOGO = "images/sffs-logo.png";

const Brain: React.FC<{ w: number; rot: number; left: number; top: number }> = ({ w, rot, left, top }) => (
  <div style={{ position: "absolute", left, top, transform: "translate(-50%, -50%)" }}>
    <Img src={staticFile(LOGO)} style={{ width: w, height: "auto", display: "block", transform: `rotate(${rot}deg)`, filter: hardDropShadow(14) }} />
  </div>
);

const Center: React.FC<{ cx: number; cy: number; children: React.ReactNode }> = ({ cx, cy, children }) => (
  <div style={{ position: "absolute", left: cx, top: cy, transform: "translate(-50%, -50%)", width: "max-content", display: "flex", alignItems: "center", justifyContent: "center" }}>
    {children}
  </div>
);

// ---- 9:16 (1080x1920) ----------------------------------------------------
export const ThumbV: React.FC = () => (
  <Stage bg={COLORS.yellow}>
    <Center cx={540} cy={336}>
      <BrandPill fill={COLORS.paper} size={44} pad="16px 40px" shadow={9} maxWidth={900}>
        REAL IQ TEST · GRADES K-12
      </BrandPill>
    </Center>
    <Center cx={540} cy={588}>
      <div style={titleStyle(154, COLORS.blue)}>CAN YOUR</div>
    </Center>
    <Center cx={540} cy={772}>
      <div style={titleStyle(154, COLORS.coral)}>KID PASS?</div>
    </Center>
    <Brain w={540} rot={-6} left={540} top={1156} />
    <Center cx={540} cy={1616}>
      <BrandPill fill={COLORS.yellow} size={54} pad="22px 44px" shadow={11} maxWidth={940}>
        SMART FELLA OR FART SMELLA?
      </BrandPill>
    </Center>
  </Stage>
);

// ---- 1:1 (1080x1080) -----------------------------------------------------
export const ThumbSq: React.FC = () => (
  <Stage bg={COLORS.blue}>
    <Center cx={540} cy={250}>
      <div style={titleStyle(120, COLORS.yellow)}>CAN YOUR</div>
    </Center>
    <Center cx={540} cy={408}>
      <div style={titleStyle(120, COLORS.coral)}>KID PASS?</div>
    </Center>
    <Brain w={360} rot={-6} left={540} top={690} />
    <Center cx={540} cy={946}>
      <BrandPill fill={COLORS.paper} size={44} pad="18px 40px" shadow={10} maxWidth={880}>
        SMART FELLA OR FART SMELLA?
      </BrandPill>
    </Center>
  </Stage>
);

// ---- 16:9 (1920x1080) ----------------------------------------------------
export const ThumbWide: React.FC = () => (
  <Stage bg={COLORS.green}>
    <Center cx={648} cy={196}>
      <BrandPill fill={COLORS.yellow} size={40} pad="14px 36px" shadow={9} maxWidth={900}>
        SMART FELLA OR FART SMELLA?
      </BrandPill>
    </Center>
    <Center cx={648} cy={432}>
      <div style={titleStyle(150, COLORS.blue)}>CAN YOUR</div>
    </Center>
    <Center cx={648} cy={620}>
      <div style={titleStyle(150, COLORS.coral)}>KID PASS?</div>
    </Center>
    <Center cx={648} cy={806}>
      <BrandPill fill={COLORS.paper} size={40} pad="14px 34px" shadow={9} maxWidth={860}>
        A REAL IQ TEST · ACTUALLY FUN
      </BrandPill>
    </Center>
    <Brain w={560} rot={8} left={1470} top={520} />
  </Stage>
);
