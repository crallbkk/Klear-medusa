// Mirror of the storefront's `src/lib/catalogue/frames.ts` FRAME_CATALOGUE.
// Embedded here so the migration script is self-contained — once Medusa
// is the source of truth, this file is the bootstrap snapshot of the
// catalogue at Phase 2.3 cutover (2026-05-11). Future product changes
// happen in Medusa Admin, not here.

export type FrameMaterial = "acetate" | "metal" | "tr90" | "titanium";
export type FrameShape =
  | "round"
  | "square"
  | "rectangle"
  | "cat-eye"
  | "aviator"
  | "geometric";
export type FrameSize = "small" | "medium" | "large";
export type FrameFaceShape = "round" | "oval" | "square" | "heart" | "diamond";
export type FrameStatus = "active" | "out_of_stock" | "coming_soon" | "archived";

export interface FrameSeed {
  sku: string;
  handle: string;
  name: { th: string; en: string };
  blurb: { th: string; en: string };
  description: { th: string; en: string };
  price_thb: number;
  spec: {
    sku: string;
    name: string;
    color: string;
    size: string;
    lens_width_mm: number;
    bridge_mm: number;
    temple_mm: number;
    min_fitting_height_mm: number;
  };
  shape: FrameShape;
  material: FrameMaterial;
  size: FrameSize;
  recommended_face_shapes: FrameFaceShape[];
  progressives_supported: boolean;
  images: {
    front: string;
    three_quarter: string;
    side: string;
    on_face: string;
  };
  ar_glb_key: string | null;
  status: FrameStatus;
  sort_order: number;
}

export const FRAME_SEED: FrameSeed[] = [
  {
    sku: "KLR-RD-001-BLACK-M",
    handle: "klear-classic-round-black",
    name: { th: "เคลียร์ คลาสสิค กลม สีดำ", en: "Klear Classic Round — Black" },
    blurb: {
      th: "ทรงกลมคลาสสิค โครงน้ำหนักเบา ใส่สบายตลอดวัน",
      en: "Timeless round acetate, lightweight, all-day comfort.",
    },
    description: {
      th: "กรอบอะซิเตทระดับพรีเมียม ผลิตที่จีนตามมาตรฐานยุโรป ทรงกลมที่เข้าได้กับใบหน้าแทบทุกแบบ",
      en: "Premium acetate built to European standards. The round shape suits almost every face.",
    },
    price_thb: 600,
    spec: {
      sku: "KLR-RD-001-BLACK-M",
      name: "Classic Round 001",
      color: "Black",
      size: "50-20-145",
      lens_width_mm: 50,
      bridge_mm: 20,
      temple_mm: 145,
      min_fitting_height_mm: 32,
    },
    shape: "round",
    material: "acetate",
    size: "medium",
    recommended_face_shapes: ["square", "heart", "diamond"],
    progressives_supported: true,
    images: {
      front: "frames/KLR-RD-001-BLACK-M/front.webp",
      three_quarter: "frames/KLR-RD-001-BLACK-M/three-quarter.webp",
      side: "frames/KLR-RD-001-BLACK-M/side.webp",
      on_face: "frames/KLR-RD-001-BLACK-M/on-face.webp",
    },
    ar_glb_key: null,
    status: "active",
    sort_order: 10,
  },
  {
    sku: "KLR-RD-001-TORTOISE-M",
    handle: "klear-classic-round-tortoise",
    name: { th: "เคลียร์ คลาสสิค กลม สีน้ำตาลลายเสือ", en: "Klear Classic Round — Tortoise" },
    blurb: {
      th: "ทรงกลมในโทนน้ำตาลอุ่น เหมาะกับสีผิวคนไทย",
      en: "Round acetate in warm tortoise — flatters most Thai skin tones.",
    },
    description: {
      th: "ทรงกลมทรงเดียวกับสีดำ แต่ในโทนสีน้ำตาลลายเสือที่ให้ลุคอบอุ่นและเป็นมิตรกว่า",
      en: "Same round shape as the black, finished in warm tortoise for a friendlier vibe.",
    },
    price_thb: 600,
    spec: {
      sku: "KLR-RD-001-TORTOISE-M",
      name: "Classic Round 001",
      color: "Tortoise",
      size: "50-20-145",
      lens_width_mm: 50,
      bridge_mm: 20,
      temple_mm: 145,
      min_fitting_height_mm: 32,
    },
    shape: "round",
    material: "acetate",
    size: "medium",
    recommended_face_shapes: ["square", "heart", "diamond"],
    progressives_supported: true,
    images: {
      front: "frames/KLR-RD-001-TORTOISE-M/front.webp",
      three_quarter: "frames/KLR-RD-001-TORTOISE-M/three-quarter.webp",
      side: "frames/KLR-RD-001-TORTOISE-M/side.webp",
      on_face: "frames/KLR-RD-001-TORTOISE-M/on-face.webp",
    },
    ar_glb_key: null,
    status: "active",
    sort_order: 11,
  },
  {
    sku: "KLR-SQ-002-BLACK-M",
    handle: "klear-modern-square-black",
    name: { th: "เคลียร์ โมเดิร์น สี่เหลี่ยม สีดำ", en: "Klear Modern Square — Black" },
    blurb: {
      th: "ทรงสี่เหลี่ยมเหลี่ยมคม ดูจริงจัง เหมาะกับสายทำงาน",
      en: "Sharp square shape — work-ready and professional.",
    },
    description: {
      th: "ทรงสี่เหลี่ยมขอบคมที่ให้ลุคแน่นอนและน่าเชื่อถือ เหมาะกับใบหน้าทรงกลมหรือไข่",
      en: "Crisp square cut for a confident, professional look. Best on round and oval faces.",
    },
    price_thb: 600,
    spec: {
      sku: "KLR-SQ-002-BLACK-M",
      name: "Modern Square 002",
      color: "Black",
      size: "52-18-145",
      lens_width_mm: 52,
      bridge_mm: 18,
      temple_mm: 145,
      min_fitting_height_mm: 34,
    },
    shape: "square",
    material: "acetate",
    size: "medium",
    recommended_face_shapes: ["round", "oval"],
    progressives_supported: true,
    images: {
      front: "frames/KLR-SQ-002-BLACK-M/front.webp",
      three_quarter: "frames/KLR-SQ-002-BLACK-M/three-quarter.webp",
      side: "frames/KLR-SQ-002-BLACK-M/side.webp",
      on_face: "frames/KLR-SQ-002-BLACK-M/on-face.webp",
    },
    ar_glb_key: null,
    status: "active",
    sort_order: 20,
  },
  {
    sku: "KLR-RC-003-NAVY-L",
    handle: "klear-rectangle-navy-large",
    name: { th: "เคลียร์ สี่เหลี่ยมผืนผ้า สีกรมท่า ขนาดใหญ่", en: "Klear Rectangle — Navy, Large" },
    blurb: {
      th: "ทรงสี่เหลี่ยมผืนผ้าขนาดใหญ่ในโทนกรมท่าใส่สบายสำหรับหน้ากว้าง",
      en: "Roomy rectangle in navy — built for wider faces.",
    },
    description: {
      th: "ขนาดใหญ่กว่ารุ่นมาตรฐาน เหมาะกับใบหน้าที่กว้างขึ้น โครงอะซิเตทแข็งแรงทนทาน",
      en: "Wider than our standard rectangle — designed for larger faces. Sturdy acetate build.",
    },
    price_thb: 700,
    spec: {
      sku: "KLR-RC-003-NAVY-L",
      name: "Rectangle 003",
      color: "Navy",
      size: "56-18-150",
      lens_width_mm: 56,
      bridge_mm: 18,
      temple_mm: 150,
      min_fitting_height_mm: 36,
    },
    shape: "rectangle",
    material: "acetate",
    size: "large",
    recommended_face_shapes: ["round", "oval", "heart"],
    progressives_supported: true,
    images: {
      front: "frames/KLR-RC-003-NAVY-L/front.webp",
      three_quarter: "frames/KLR-RC-003-NAVY-L/three-quarter.webp",
      side: "frames/KLR-RC-003-NAVY-L/side.webp",
      on_face: "frames/KLR-RC-003-NAVY-L/on-face.webp",
    },
    ar_glb_key: null,
    status: "active",
    sort_order: 30,
  },
  {
    sku: "KLR-CT-004-CLEAR-S",
    handle: "klear-cat-eye-clear-small",
    name: { th: "เคลียร์ แคทอาย สีใส ขนาดเล็ก", en: "Klear Cat-Eye — Clear, Small" },
    blurb: {
      th: "ทรงแคทอายโครงใสสำหรับใบหน้าเล็ก ไม่รองรับเลนส์โปรเกรสซีฟ",
      en: "Petite clear cat-eye. Single-vision lenses only.",
    },
    description: {
      th: "ทรงแคทอายเล็กกะทัดรัด ในโทนใสที่ดูเบาและสะอาด เนื่องจากความสูงของกรอบเล็ก ไม่รองรับเลนส์โปรเกรสซีฟ",
      en: "A petite clear cat-eye for small faces. Frame height is too short to fit progressive lenses — single-vision only.",
    },
    price_thb: 600,
    spec: {
      sku: "KLR-CT-004-CLEAR-S",
      name: "Cat-Eye 004",
      color: "Clear",
      size: "48-16-140",
      lens_width_mm: 48,
      bridge_mm: 16,
      temple_mm: 140,
      min_fitting_height_mm: 22,
    },
    shape: "cat-eye",
    material: "acetate",
    size: "small",
    recommended_face_shapes: ["round", "diamond"],
    progressives_supported: false,
    images: {
      front: "frames/KLR-CT-004-CLEAR-S/front.webp",
      three_quarter: "frames/KLR-CT-004-CLEAR-S/three-quarter.webp",
      side: "frames/KLR-CT-004-CLEAR-S/side.webp",
      on_face: "frames/KLR-CT-004-CLEAR-S/on-face.webp",
    },
    ar_glb_key: null,
    status: "active",
    sort_order: 40,
  },
  {
    sku: "KLR-AV-005-GOLD-M",
    handle: "klear-aviator-gold",
    name: { th: "เคลียร์ เอวิเอเตอร์ สีทอง", en: "Klear Aviator — Gold" },
    blurb: {
      th: "ทรงเอวิเอเตอร์โครงโลหะสีทอง น้ำหนักเบามาก",
      en: "Gold metal aviator — feather-light.",
    },
    description: {
      th: "โครงโลหะน้ำหนักเบาในทรงเอวิเอเตอร์คลาสสิค รูจมูกซิลิโคนนุ่มสำหรับใส่ตลอดวัน",
      en: "Lightweight metal in the classic aviator silhouette. Soft silicone nose pads for all-day wear.",
    },
    price_thb: 800,
    spec: {
      sku: "KLR-AV-005-GOLD-M",
      name: "Aviator 005",
      color: "Gold",
      size: "54-18-145",
      lens_width_mm: 54,
      bridge_mm: 18,
      temple_mm: 145,
      min_fitting_height_mm: 38,
    },
    shape: "aviator",
    material: "metal",
    size: "medium",
    recommended_face_shapes: ["square", "oval", "heart"],
    progressives_supported: true,
    images: {
      front: "frames/KLR-AV-005-GOLD-M/front.webp",
      three_quarter: "frames/KLR-AV-005-GOLD-M/three-quarter.webp",
      side: "frames/KLR-AV-005-GOLD-M/side.webp",
      on_face: "frames/KLR-AV-005-GOLD-M/on-face.webp",
    },
    ar_glb_key: null,
    status: "active",
    sort_order: 50,
  },
  {
    sku: "KLR-GE-006-MATTEBLACK-M",
    handle: "klear-geometric-matte-black",
    name: { th: "เคลียร์ เรขาคณิต สีดำด้าน", en: "Klear Geometric — Matte Black" },
    blurb: {
      th: "ทรงเรขาคณิตเหลี่ยมโครง TR90 น้ำหนักเบา ทนทาน",
      en: "Faceted geometric shape in lightweight TR90.",
    },
    description: {
      th: "ทรงเรขาคณิตที่โดดเด่นไม่เหมือนใคร ในวัสดุ TR90 น้ำหนักเบาและยืดหยุ่นสูง ทนต่อการกระแทก",
      en: "Standout faceted shape in TR90 — flexible, lightweight, impact-resistant.",
    },
    price_thb: 700,
    spec: {
      sku: "KLR-GE-006-MATTEBLACK-M",
      name: "Geometric 006",
      color: "Matte Black",
      size: "52-19-145",
      lens_width_mm: 52,
      bridge_mm: 19,
      temple_mm: 145,
      min_fitting_height_mm: 33,
    },
    shape: "geometric",
    material: "tr90",
    size: "medium",
    recommended_face_shapes: ["oval", "round"],
    progressives_supported: true,
    images: {
      front: "frames/KLR-GE-006-MATTEBLACK-M/front.webp",
      three_quarter: "frames/KLR-GE-006-MATTEBLACK-M/three-quarter.webp",
      side: "frames/KLR-GE-006-MATTEBLACK-M/side.webp",
      on_face: "frames/KLR-GE-006-MATTEBLACK-M/on-face.webp",
    },
    ar_glb_key: null,
    status: "active",
    sort_order: 60,
  },
  {
    sku: "KLR-RC-007-CRYSTAL-S",
    handle: "klear-rectangle-crystal-small",
    name: { th: "เคลียร์ สี่เหลี่ยมผืนผ้า สีคริสตัล ขนาดเล็ก", en: "Klear Rectangle — Crystal, Small" },
    blurb: {
      th: "สี่เหลี่ยมผืนผ้าขนาดเล็กโครงคริสตัลใส เหมาะกับใบหน้าเล็ก",
      en: "Petite crystal-clear rectangle for smaller faces.",
    },
    description: {
      th: "ทรงสี่เหลี่ยมผืนผ้าขนาดเล็กในโทนคริสตัลใส เป็นกลางและเข้าได้กับทุกลุค",
      en: "A petite crystal-clear rectangle. Neutral, versatile, easy to wear.",
    },
    price_thb: 600,
    spec: {
      sku: "KLR-RC-007-CRYSTAL-S",
      name: "Rectangle 007",
      color: "Crystal",
      size: "48-17-140",
      lens_width_mm: 48,
      bridge_mm: 17,
      temple_mm: 140,
      min_fitting_height_mm: 30,
    },
    shape: "rectangle",
    material: "acetate",
    size: "small",
    recommended_face_shapes: ["round", "heart", "oval"],
    progressives_supported: true,
    images: {
      front: "frames/KLR-RC-007-CRYSTAL-S/front.webp",
      three_quarter: "frames/KLR-RC-007-CRYSTAL-S/three-quarter.webp",
      side: "frames/KLR-RC-007-CRYSTAL-S/side.webp",
      on_face: "frames/KLR-RC-007-CRYSTAL-S/on-face.webp",
    },
    ar_glb_key: null,
    status: "coming_soon",
    sort_order: 70,
  },
];
