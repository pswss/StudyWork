// Scene.tsx — StudyWork 정적 3D 센터피스
// 로그인·과목 목록에서만 한 프레임을 그려 브랜드 질감은 남기고 유휴 GPU 사용은 피한다.

import { useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { Environment, MeshDistortMaterial } from "@react-three/drei";
import { Mood } from "./mood";

const SMALL =
  typeof window !== "undefined" && window.innerWidth < 720;

// mood별 정적 조형물 — 한 프레임만 그려 유휴 GPU 사용을 피한다.
interface MoodTarget {
  pos: [number, number, number];
  distort: number;
  scale: number;
  dim: number; // 재질 투명도(작을수록 어둡게 물러남)
}

function moodTarget(mood: Mood, accent: number): MoodTarget {
  // 로그인: 중앙에 크게 / 과목: 오른쪽으로 흘러감 / 상세: 작게 물러남
  switch (mood) {
    case "login":
      return { pos: [0, 0.1, 0], distort: 0.34, scale: 1.65, dim: 1 };
    case "subjects":
      return { pos: [2.35, 0.15, -0.5], distort: 0.3, scale: 1.45, dim: 0.92 };
    case "detail":
      // 학습 화면에서는 조형물을 배경으로 물려 과업보다 먼저 보이지 않게 한다.
      return {
        pos: [3.6, -0.55, -2],
        distort: 0.1 + accent * 0.005,
        scale: 0.9,
        dim: 0.4,
      };
  }
}

// ── 중앙 흑요석 조형물 ────────────────────────────────────────────────────────
function Obsidian({ mood, accent }: { mood: Mood; accent: number }) {
  const target = moodTarget(mood, accent);
  const detail = SMALL ? 3 : 6;

  return (
    <group position={target.pos} scale={target.scale}>
      <mesh rotation={[0.15, 0.35, 0.08]} castShadow={false}>
        <icosahedronGeometry args={[1, detail]} />
        {/* 흑요석 물리 재질 — 플레이북 폴백 레시피(아이패드 부드러움 우선):
            clearcoat 1, roughness .15, near-black #0a0a0c. 유리질 트랜스미션
            대신 이 경로를 택해 저사양에서도 60fps를 유지한다. */}
        <MeshDistortMaterial
          color="#0a0a0c"
          roughness={0.15}
          metalness={0.4}
          clearcoat={1}
          clearcoatRoughness={0.22}
          reflectivity={1}
          distort={target.distort}
          speed={0}
          transparent
          opacity={target.dim}
          envMapIntensity={1.2}
        />
      </mesh>
    </group>
  );
}

// ── 주변 파편 샤드 ────────────────────────────────────────────────────────────
function Shards({ mood }: { mood: Mood }) {
  const count = mood === "detail" ? 0 : SMALL ? 4 : 7;
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

  return (
    <group position={[mood === "subjects" ? 0.8 : 0, 0, 0]}>
      {shards.map((sh, i) => (
        <mesh key={i} position={sh.pos} rotation={sh.rot} scale={sh.s}>
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
  const dpr = SMALL ? 1 : 1.5;
  return (
    <Canvas
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
      }}
      dpr={[1, dpr]}
      gl={{ antialias: !SMALL, alpha: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 0, 6], fov: 42 }}
      frameloop="demand"
    >
      <Lights />
      <Obsidian mood={mood} accent={accent} />
      <Shards mood={mood} />
      <Environment preset="city" environmentIntensity={0.5} />
    </Canvas>
  );
}
