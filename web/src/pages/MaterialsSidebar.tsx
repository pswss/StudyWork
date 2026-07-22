// MaterialsSidebar.tsx — 자료 사이드바 (SubjectDetail에서 순수 이동)
// 업로드(파일·텍스트)·상태 표시·재시도·중단·삭제. 목록 상태(mats)는 부모 소유.
import { useState, useEffect, useRef } from "react";
import { useEscape } from "../escape";
import {
  Subject, Material,
  uploadMaterial, retryMaterial, deleteMaterial, cancelMaterial,
  retryBookFile, cancelBookFile,
} from "../api";

export function uploadValidationError(file: Pick<File, "name" | "type" | "size">): string | null {
  const lower = file.name.toLowerCase();
  const isPdf = file.type === "application/pdf" || lower.endsWith(".pdf");
  const isImage = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)
    || /\.(jpe?g|png|webp|gif)$/.test(lower);
  if (!isPdf && !isImage) return "PDF, JPEG, PNG, WebP, GIF만 지원합니다";
  const maxBytes = isPdf ? 200 * 1024 * 1024 : 30 * 1024 * 1024;
  if (file.size <= 0 || file.size > maxBytes) {
    return `${isPdf ? "200MB" : "30MB"} 이하 파일만 지원합니다`;
  }
  return null;
}

function kindLabel(k: Material["kind"]) {
  return k === "image" ? "사진" : k === "pdf" ? "PDF" : "텍스트";
}

interface Props {
  subject: Subject;
  mats: Material[];
  /** 자료 목록 재적재 — 부모의 loadMats(subjectId, refreshAfterPending=true) */
  reloadMats: (subjectId: number) => Promise<void>;
}

export default function MaterialsSidebar({ subject, mats, reloadMats }: Props) {
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [materialActionId, setMaterialActionId] = useState<number | null>(null);
  const [showTextForm, setShowTextForm] = useState(false);
  const [textTitle, setTextTitle] = useState("");
  const [textBody, setTextBody] = useState("");

  useEscape(showTextForm, () => setShowTextForm(false));
  const mountedRef = useRef(true);
  const subjectIdRef = useRef(subject.id);
  const materialActionRef = useRef<number | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => { subjectIdRef.current = subject.id; }, [subject.id]);

  // file upload — 여러 파일 가능. 모두 자료로 처리되고, 문제가 있으면 서버가 자동으로 문제 칸에 등록한다.
  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length === 0) return;
    e.target.value = "";
    const uploadSubjectId = subject.id;
    const errors: string[] = [];
    setUploading(true);
    setUploadStatus(`0/${files.length}`);
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const validationError = uploadValidationError(file);
        if (validationError) {
          errors.push(`${file.name}: ${validationError}`);
          if (subjectIdRef.current === uploadSubjectId) setUploadStatus(`${index + 1}/${files.length}`);
          continue;
        }
        const fd = new FormData();
        fd.append("title", file.name);
        fd.append("file", file);
        try {
          await uploadMaterial(uploadSubjectId, fd);
        } catch (error) {
          errors.push(`${file.name}: ${error instanceof Error ? error.message : "업로드 실패"}`);
        } finally {
          if (mountedRef.current && subjectIdRef.current === uploadSubjectId) {
            setUploadStatus(`${index + 1}/${files.length}`);
          }
          await reloadMats(uploadSubjectId);
        }
      }
      if (errors.length > 0 && mountedRef.current && subjectIdRef.current === uploadSubjectId) {
        alert(errors.join("\n"));
      }
    } finally {
      if (mountedRef.current) {
        setUploading(false);
        setUploadStatus("");
      }
    }
  }

  // text upload
  async function submitText() {
    const title = textTitle.trim();
    const text = textBody.trim();
    if (!title || !text) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("title", title);
      fd.append("text", text);
      await uploadMaterial(subject.id, fd);
      if (!mountedRef.current) return;
      setTextTitle(""); setTextBody(""); setShowTextForm(false);
      await reloadMats(subject.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "저장 실패");
    } finally {
      if (mountedRef.current) setUploading(false);
    }
  }

  async function runMaterialAction(id: number, action: () => Promise<unknown>) {
    if (materialActionRef.current !== null) return;
    materialActionRef.current = id;
    setMaterialActionId(id);
    try {
      await action();
    } catch (error) {
      alert(error instanceof Error ? error.message : "자료 작업에 실패했습니다");
    } finally {
      await reloadMats(subject.id);
      materialActionRef.current = null;
      if (mountedRef.current) setMaterialActionId(null);
    }
  }

  // retry material
  async function retry(id: number) {
    await runMaterialAction(id, () => retryMaterial(id));
  }

  // cancel material analysis
  async function doCancelMat(id: number) {
    await runMaterialAction(id, () => cancelMaterial(id));
  }

  async function doRetryBook(id: number, fileId: number) {
    await runMaterialAction(id, () => retryBookFile(fileId));
  }

  async function doCancelBook(id: number, fileId: number) {
    await runMaterialAction(id, () => cancelBookFile(fileId));
  }

  // delete material
  async function doDeleteMat(material: Material) {
    const confirmation = prompt(
      `"${material.title}" 자료를 삭제하면 이 자료에서 추출된 문제와 원본 그림도 모두 삭제됩니다.\n\n계속하려면 "삭제"를 입력하세요.`
    );
    if (confirmation?.trim() !== "삭제") return;
    await runMaterialAction(material.id, () => deleteMaterial(material.id));
  }

  return (
    <div className="sidebar">
      <div className="panel sidebar-panel">
        <div className="sidebar-title">자료</div>
        {mats.length === 0 && <p style={{ color: "var(--ink-3)", fontSize: 13 }}>자료가 없습니다.</p>}
        <div className="mat-list">
          {mats.map(m => (
            <div className="mat-entry" key={m.id}>
              <div className="mat-row">
                <span className="kind-chip">{kindLabel(m.kind)}</span>
                {m.source_type === "obsidian" && (
                  <span className="kind-chip" title={m.source_path ?? "Obsidian"}>OBS</span>
                )}
                <span className="mat-title" title={m.original_filename ?? m.title}>{m.title}</span>
                {m.status === "processing" && (
                  <>
                    <span className="status-dot processing" />
                    <span className="quiz-status-msg">
                      {m.retry_chunk_count
                        ? `${m.progress}% · 오류·미완료 ${m.retry_chunk_count}개 청크만 재시도 중`
                        : `${m.progress}%`}
                    </span>
                    <button
                      className="retry-btn"
                      title="분석 중단"
                      disabled={materialActionId !== null}
                      onClick={() => doCancelMat(m.id)}
                    >중단</button>
                  </>
                )}
                {m.status === "ready" && (
                  <>
                    <span className="status-dot ready" />
                    {m.book_status === "processing" && (
                      <>
                        <span className="quiz-status-msg" title="문제·해설을 뽑아 문제 칸에 등록 중">
                          {m.book_retry_chunk_count && m.book_error?.includes("오류·미완료")
                            ? `문제 추출 ${m.book_progress ?? 0}% · 오류·미완료 ${m.book_retry_chunk_count}개 청크만 재시도 중`
                            : `문제 추출 ${m.book_progress ?? 0}%`}
                        </span>
                        {m.book_file_id && (
                          <button
                            className="retry-btn"
                            disabled={materialActionId !== null}
                            onClick={() => doCancelBook(m.id, m.book_file_id!)}
                          >중단</button>
                        )}
                      </>
                    )}
                    {m.book_status === "error" && m.book_file_id && (
                      <button
                        className="retry-btn"
                        title={m.book_error ?? "문제 추출 실패"}
                        disabled={materialActionId !== null}
                        onClick={() => doRetryBook(m.id, m.book_file_id!)}
                      >문제 재시도</button>
                    )}
                  </>
                )}
                {m.status === "error" && (
                  <>
                    <span className="status-dot error" />
                    <button
                      className="retry-btn"
                      disabled={materialActionId !== null}
                      onClick={() => retry(m.id)}
                    >재시도</button>
                  </>
                )}
                <button
                  className="del-btn"
                  aria-label={`${m.title} 삭제`}
                  disabled={materialActionId !== null}
                  onClick={() => doDeleteMat(m)}
                >✕</button>
              </div>
              {m.status === "error" && m.error && <div className="mat-error">{m.error}</div>}
              {m.status === "error" && Boolean(m.retry_chunk_count) && (
                <div className="mat-warning">
                  오류·미완료 {m.retry_chunk_count}/{m.chunk_total ?? "?"}개 청크. 재시도하면 이 청크만 다시 분석합니다.
                </div>
              )}
              {m.integrity_warning && !m.integrity_warning.startsWith("페이지 근거 불완전:") && (
                <div className="mat-warning">{m.integrity_warning}</div>
              )}
              {m.book_status === "error" && (
                <>
                  <div className="mat-error">{m.book_error ?? "문제 추출에 실패했습니다. 재시도해 주세요."}</div>
                  {Boolean(m.book_retry_chunk_count) && (
                    <div className="mat-warning">
                      오류·미완료 {m.book_retry_chunk_count}/{m.book_chunk_total ?? "?"}개 청크. 다음 재시도에서는 이 청크만 다시 추출합니다.
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>

        <div className="upload-area">
          <label className="file-label">
            자료 추가 (문제·해설 있으면 자동으로 문제 칸에 등록)
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,application/pdf,image/jpeg,image/png,image/webp,image/gif"
              multiple
              onChange={onFileChange}
              disabled={uploading}
            />
          </label>
          <div className="upload-help">PDF 200MB·500쪽 이하 / 이미지 30MB 이하</div>
          {uploading && <div className="upload-status">업로드 중 {uploadStatus}</div>}
          <button
            className="btn sm"
            style={{ width: "100%" }}
            onClick={() => setShowTextForm(v => !v)}
          >
            텍스트 추가
          </button>
          {showTextForm && (
            <div className="text-form">
              <input
                className="text-input"
                placeholder="제목"
                value={textTitle}
                onChange={e => setTextTitle(e.target.value)}
              />
              <textarea
                className="text-input"
                placeholder="내용"
                value={textBody}
                onChange={e => setTextBody(e.target.value)}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn sm primary" style={{ flex: 1 }} onClick={submitText} disabled={uploading}>저장</button>
                <button className="btn sm" onClick={() => setShowTextForm(false)}>취소</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
