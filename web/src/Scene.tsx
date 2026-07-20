// Scene.tsx — OBSIDIAN ARCHIVE 3D 센터피스
// 고정 전체화면 배경 캔버스. 흑요석/유리질 조형물이 천천히 회전하고,
// 화면(mood)에 따라 위치·왜곡·회전이 미묘하게 변한다. 마우스 패럴랙스(lerp).
// 성능: dpr 상한 1.5, 작은 화면은 품질 하향, prefers-reduced-motion이면 정지 프레임.

import { useRef, useMemo, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Environment, MeshDistortMaterial, Float,
  AdaptiveDpr, AdaptiveEvents, PerformanceMonitor,
} from "@react-three/drei";
import * as THREE from "three";
import { Mood } from "./mood";

const REDUCED =
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const SMALL =
  typeof window !== "undefined" && window.innerWidth < 720;

// mood별 조형물 목표값 — 위치/왜곡/회전속도/스케일
interface MoodTarget {
  pos: [number, number, number];
  distort: number;
  speed: number;
  scale: number;
  dim: number; // 재질 투명도(작을수록 어둡게 물러남)
}

function moodTarget(mood: Mood, accent: number): MoodTarget {
  // 로그인: 중앙에 크게 / 과목: 오른쪽으로 흘러감 / 상세: 작게 물러남
  switch (mood) {
    case "login":
      return { pos: [0, 0.1, 0], distort: 0.34, speed: 0.28, scale: 1.65, dim: 1 };
    case "subjects":
      return { pos: [2.35, 0.15, -0.5], distort: 0.3, speed: 0.22, scale: 1.45, dim: 0.92 };
    case "detail":
      // 탭(accent)마다 회전속도/왜곡을 조금씩 달리해 "반응"하게
      return {
        pos: [3.15, -0.35, -1.4],
        distort: 0.22 + accent * 0.02,
        speed: 0.16 + accent * 0.03,
        scale: 1.15,
        dim: 0.72,
      };
  }
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

// ── 중앙 흑요석 조형물 ────────────────────────────────────────────────────────
function Obsidian({ mood, accent }: { mood: Mood; accent: number }) {
  const group = useRef<THREE.Group>(null);
  const mesh = useRef<THREE.Mesh>(null);
  const matRef = useRef<any>(null);
  const { pointer } = useThree();
  // lerp 상태
  const cur = useRef({ x: 0, y: 0, z: 0, distort: 0.3, scale: 1.5, dim: 1, mx: 0, my: 0 });

  useFrame((_, delta) => {
    const g = group.current;
    const m = mesh.current;
    if (!g || !m) return;
    const t = moodTarget(mood, accent);
    const c = cur.current;
    const k = REDUCED ? 1 : Math.min(1, delta * 2.4); // 프레임 독립 lerp

    c.x = lerp(c.x, t.pos[0], k);
    c.y = lerp(c.y, t.pos[1], k);
    c.z = lerp(c.z, t.pos[2], k);
    c.distort = lerp(c.distort, t.distort, k);
    c.scale = lerp(c.scale, t.scale, k);
    c.dim = lerp(c.dim, t.dim, k);

    // 마우스 패럴랙스 (lerp) — 데스크톱만 의미있게 반응
    const px = REDUCED ? 0 : pointer.x;
    const py = REDUCED ? 0 : pointer.y;
    c.mx = lerp(c.mx, px, Math.min(1, delta * 3));
    c.my = lerp(c.my, py, Math.min(1, delta * 3));

    g.position.set(c.x + c.mx * 0.5, c.y + c.my * 0.35, c.z);
    g.scale.setScalar(c.scale);
    // 마우스 방향으로 살짝 기울고, 천천히 자전
    const spin = REDUCED ? 0 : moodTarget(mood, accent).speed;
    m.rotation.y += delta * spin;
    m.rotation.x = lerp(m.rotation.x, c.my * -0.4, 0.06);
    m.rotation.z = lerp(m.rotation.z, c.mx * 0.25, 0.06);

    if (matRef.current) {
      matRef.current.distort = c.distort;
      matRef.current.opacity = c.dim;
    }
  });

  const detail = SMALL ? 3 : 6;

  return (
    <group ref={group}>
      <mesh ref={mesh} castShadow={false}>
        <icosahedronGeometry args={[1, detail]} />
        {/* 흑요석 물리 재질 — 플레이북 폴백 레시피(아이패드 부드러움 우선):
            clearcoat 1, roughness .15, near-black #0a0a0c. 유리질 트랜스미션
            대신 이 경로를 택해 저사양에서도 60fps를 유지한다. */}
        <MeshDistortMaterial
          ref={matRef}
          color="#0a0a0c"
          roughness={0.15}
          metalness={0.4}
          clearcoat={1}
          clearcoatRoughness={0.22}
          reflectivity={1}
          distort={0.3}
          speed={REDUCED ? 0 : 1.1}
          transparent
          opacity={1}
          envMapIntensity={1.2}
        />
      </mesh>
    </group>
  );
}

// ── 주변 파편 샤드 ────────────────────────────────────────────────────────────
function Shards({ mood }: { mood: Mood }) {
  const count = SMALL ? 4 : 7;
  const shards = useMemo(() => {
    const arr: { pos: [number, number, number]; rot: [number, number, number]; s: number }[] = [];
    // 결정적 배치(랜덤 시드 고정)로 "매번 다른 AI 느낌" 방지
    const seed = [
      [-2.6, 1.5, -2, 0.28],
      [2.2, -1.7, -1.5, 0.22],
      [-1.9, -1.9, -2.6, 0.18],
      [1.6, 1.9, -2.2, 0.24],
      [-3.1, -0.4, -1.2, 0.16],
      [2.9, 0.9, -2.8, 0.2],
      [0.2, 2.3, -3, 0.15],
    ];
    for (let i = 0; i < count; i++) {
      const [x, y, z, s] = seed[i];
      arr.push({
        pos: [x, y, z],
        rot: [i * 0.7, i * 1.3, i * 0.4],
        s,
      });
    }
    return arr;
  }, [count]);

  const grp = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    if (!grp.current || REDUCED) return;
    // 과목/상세로 갈수록 파편이 살짝 흩어짐
    grp.current.rotation.y += delta * 0.04;
    const targetX = mood === "login" ? 0 : mood === "subjects" ? 0.8 : 1.2;
    grp.current.position.x = lerp(grp.current.position.x, targetX, Math.min(1, delta * 1.5));
  });

  return (
    <group ref={grp}>
      {shards.map((sh, i) => (
        <Float
          key={i}
          speed={REDUCED ? 0 : 1.2 + (i % 3) * 0.4}
          rotationIntensity={REDUCED ? 0 : 0.6}
          floatIntensity={REDUCED ? 0 : 0.8}
        >
          <mesh position={sh.pos} rotation={sh.rot} scale={sh.s}>
            <octahedronGeometry args={[1, 0]} />
            <meshPhysicalMaterial
              color="#0c0c0f"
              roughness={0.2}
              metalness={0.4}
              clearcoat={1}
              clearcoatRoughness={0.3}
              envMapIntensity={0.9}
            />
          </mesh>
        </Float>
      ))}
    </group>
  );
}

// ── 라이팅 ────────────────────────────────────────────────────────────────────
function Lights() {
  return (
    <>
      <ambientLight intensity={0.35} />
      {/* 애시드 라임 림 라이트 (뒤쪽에서) */}
      <directionalLight position={[-4, 2, -3]} intensity={2.2} color="#D9FF3F" />
      {/* 본/아이보리 키 라이트 */}
      <directionalLight position={[5, 4, 5]} intensity={1.1} color="#EDEAE0" />
      {/* 아래쪽 채움광 */}
      <pointLight position={[0, -3, 2]} intensity={0.6} color="#8a8a80" />
    </>
  );
}

export default function Scene({ mood, accent }: { mood: Mood; accent: number }) {
  // 프레임률이 떨어지면 dpr 상한을 낮춰(1.5→1) 아이패드에서 60fps를 지킨다.
  const [dpr, setDpr] = useState(SMALL ? 1 : 1.5);
  return (
    <Canvas
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
      }}
      dpr={[1, dpr]}
      gl={{ antialias: !SMALL, alpha: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 0, 6], fov: 42 }}
      frameloop={REDUCED ? "demand" : "always"}
    >
      {/* 성능 감시: fps 미달 시 품질 강등, 회복 시 복구 (drei) */}
      <PerformanceMonitor
        onDecline={() => setDpr(1)}
        onIncline={() => setDpr(SMALL ? 1 : 1.5)}
      />
      <Lights />
      <Obsidian mood={mood} accent={accent} />
      <Shards mood={mood} />
      <Environment preset="city" environmentIntensity={0.5} />
      <AdaptiveDpr pixelated />
      <AdaptiveEvents />
    </Canvas>
  );
}
