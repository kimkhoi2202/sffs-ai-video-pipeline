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

/** Brand hero title: "SMART FELLA" / "OR" badge / "FART SMELLA?" stacked and
 *  centered at (cx, cy), with the signature ink stroke + hard offset shadow.
 *  `first` colors the top line (the second is always coral); it is chosen per
 *  stage so neither line blends into that stage's background. */
const BrandTitle: React.FC<{ cx: number; cy: number; size: number; orSize: number; rowGap: number; first: string }> = ({
  cx,
  cy,
  size,
  orSize,
  rowGap,
  first,
}) => (
  <div
    style={{
      position: "absolute",
      left: cx,
      top: cy,
      transform: "translate(-50%, -50%)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: rowGap,
      zIndex: 3, // paint the big title ABOVE the floating shapes where they overlap
    }}
  >
    <div style={titleStyle(size, first)}>SMART FELLA</div>
    <BrandPill fill={COLORS.paper} size={orSize} pad={`${Math.round(orSize * 0.16)}px ${Math.round(orSize * 0.55)}px`} shadow={7}>
      OR
    </BrandPill>
    <div style={titleStyle(size, COLORS.coral)}>FART SMELLA?</div>
  </div>
);

// ---- 9:16 (1080x1920) ----------------------------------------------------
export const ThumbV: React.FC = () => (
  <Stage bg={COLORS.yellow} shapePos={{ diamond: { fy: 0.585 }, hexagon: { fy: 0.595 } }}>
    <Center cx={540} cy={300}>
      <BrandPill fill={COLORS.paper} size={44} pad="16px 40px" shadow={9} maxWidth={900}>
        REAL IQ TEST · GRADES K-12
      </BrandPill>
    </Center>
    <BrandTitle cx={540} cy={760} size={172} orSize={70} rowGap={22} first={COLORS.blue} />
    <Brain w={540} rot={-6} left={540} top={1470} />
  </Stage>
);

// ---- 1:1 (1080x1080) -----------------------------------------------------
export const ThumbSq: React.FC = () => (
  <Stage bg={COLORS.blue}>
    <BrandTitle cx={540} cy={402} size={158} orSize={62} rowGap={16} first={COLORS.yellow} />
    <Brain w={372} rot={-6} left={540} top={838} />
  </Stage>
);

// ---- 16:9 (1920x1080) ----------------------------------------------------
export const ThumbWide: React.FC = () => (
  <Stage bg={COLORS.green}>
    <BrandTitle cx={620} cy={452} size={156} orSize={62} rowGap={16} first={COLORS.blue} />
    <Center cx={648} cy={824}>
      <BrandPill fill={COLORS.paper} size={40} pad="14px 34px" shadow={9} maxWidth={860}>
        A REAL IQ TEST · ACTUALLY FUN
      </BrandPill>
    </Center>
    <Brain w={560} rot={8} left={1470} top={520} />
  </Stage>
);
