// MaterialsSidebar.tsx — 자료 사이드바 (SubjectDetail에서 순수 이동)
// 업로드(파일·텍스트)·상태 표시·재시도·중단·삭제. 목록 상태(mats)는 부모 소유.
import { useState, useEffect, useRef } from "react";
import { useEscape } from "../escape";
import {
  Subject, Material,
  uploadMaterial, retryMaterial, deleteMaterial, cancelMaterial,
  retryBookFile, cancelBookFile,
} from "../api";
import { useUndoDelete } from "../UndoDelete";
import { AiPending } from "../Pending";
import { useI18n, type MessageKey, type Translate } from "../i18n";

export function uploadValidationError(
  file: Pick<File, "name" | "type" | "size">,
  t?: Translate,
): string | null {
  const lower = file.name.toLowerCase();
  const isPdf = file.type === "application/pdf" || lower.endsWith(".pdf");
  const isImage = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)
    || /\.(jpe?g|png|webp|gif)$/.test(lower);
  if (!isPdf && !isImage) {
    return t ? t("learning.materials.validation.type") : "PDF, JPEG, PNG, WebP, GIF만 지원합니다";
  }
  const maxBytes = isPdf ? 200 * 1024 * 1024 : 30 * 1024 * 1024;
  if (file.size <= 0 || file.size > maxBytes) {
    const limit = isPdf ? "200 MB" : "30 MB";
    return t ? t("learning.materials.validation.size", { limit }) : `${limit} 이하 파일만 지원합니다`;
  }
  return null;
}

function kindLabel(k: Material["kind"], t: Translate) {
  return k === "image"
    ? t("learning.materials.kind.image")
    : k === "pdf"
      ? t("learning.materials.kind.pdf")
      : t("learning.materials.kind.text");
}

interface Props {
  subject: Subject;
  mats: Material[];
  loading?: boolean;
  /** 자료 목록 재적재 — 부모의 loadMats(subjectId, refreshAfterPending=true) */
  reloadMats: (subjectId: number) => Promise<void>;
}

interface MaterialActionError {
  materialId: number;
  title: string;
  context: MessageKey;
  message: string;
  retry: () => Promise<unknown>;
}

export default function MaterialsSidebar({ subject, mats, loading = false, reloadMats }: Props) {
  const { locale, t, formatNumber } = useI18n();
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [textError, setTextError] = useState("");
  const [materialActionError, setMaterialActionError] = useState<MaterialActionError | null>(null);
  const [materialActionId, setMaterialActionId] = useState<number | null>(null);
  const [showTextForm, setShowTextForm] = useState(false);
  const [textTitle, setTextTitle] = useState("");
  const [textBody, setTextBody] = useState("");
  const { pending: pendingDelete, schedule: scheduleDelete } = useUndoDelete();

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
    setUploadErrors([]);
    const uploadSubjectId = subject.id;
    const errors: string[] = [];
    setUploading(true);
    setUploadStatus(`${formatNumber(0)}/${formatNumber(files.length)}`);
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const validationError = uploadValidationError(file, t);
        if (validationError) {
          errors.push(`${file.name}: ${validationError}`);
          if (subjectIdRef.current === uploadSubjectId) {
            setUploadStatus(`${formatNumber(index + 1)}/${formatNumber(files.length)}`);
          }
          continue;
        }
        const fd = new FormData();
        fd.append("title", file.name);
        fd.append("file", file);
        try {
          await uploadMaterial(uploadSubjectId, fd);
        } catch (error) {
          errors.push(`${file.name}: ${error instanceof Error ? error.message : t("learning.materials.uploadFailed")}`);
        } finally {
          if (mountedRef.current && subjectIdRef.current === uploadSubjectId) {
            setUploadStatus(`${formatNumber(index + 1)}/${formatNumber(files.length)}`);
          }
          await reloadMats(uploadSubjectId);
        }
      }
      if (errors.length > 0 && mountedRef.current && subjectIdRef.current === uploadSubjectId) {
        setUploadErrors(errors);
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
    setTextError("");
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("title", title);
      fd.append("text", text);
      await uploadMaterial(subject.id, fd);
      if (!mountedRef.current) return;
      await reloadMats(subject.id);
      if (!mountedRef.current) return;
      setTextTitle(""); setTextBody(""); setShowTextForm(false);
    } catch (err) {
      if (mountedRef.current) {
        setTextError(t("learning.materials.textSaveFailed", {
          error: err instanceof Error ? err.message : t("learning.materials.saveFailed"),
        }));
      }
    } finally {
      if (mountedRef.current) setUploading(false);
    }
  }

  async function runMaterialAction(
    id: number,
    title: string,
    context: MessageKey,
    action: () => Promise<unknown>,
    throwOnError = false,
  ) {
    if (materialActionRef.current !== null) return;
    materialActionRef.current = id;
    setMaterialActionId(id);
    setMaterialActionError(null);
    try {
      await action();
    } catch (error) {
      if (mountedRef.current && !throwOnError) {
        setMaterialActionError({
          materialId: id,
          title,
          context,
          message: error instanceof Error ? error.message : t("learning.materials.actionFailed"),
          retry: action,
        });
      }
      if (throwOnError) throw error;
    } finally {
      try {
        await reloadMats(subject.id);
      } finally {
        materialActionRef.current = null;
        if (mountedRef.current) setMaterialActionId(null);
      }
    }
  }

  // retry material
  async function retry(material: Material) {
    await runMaterialAction(
      material.id,
      material.title,
      "learning.materials.action.analysisRetry",
      () => retryMaterial(material.id),
    );
  }

  // cancel material analysis
  async function doCancelMat(material: Material) {
    await runMaterialAction(
      material.id,
      material.title,
      "learning.materials.action.analysisStop",
      () => cancelMaterial(material.id),
    );
  }

  async function doRetryBook(material: Material, fileId: number) {
    await runMaterialAction(
      material.id,
      material.title,
      "learning.materials.action.problemRetry",
      () => retryBookFile(fileId),
    );
  }

  async function doCancelBook(material: Material, fileId: number) {
    await runMaterialAction(
      material.id,
      material.title,
      "learning.materials.action.problemStop",
      () => cancelBookFile(fileId),
    );
  }

  // delete material
  function doDeleteMat(material: Material) {
    const confirmation = prompt(t("learning.materials.deletePrompt", {
      title: material.title,
      word: t("learning.materials.deleteWord"),
    }));
    if (confirmation?.trim() !== t("learning.materials.deleteWord")) return;
    scheduleDelete({
      key: `material:${material.id}`,
      label: t("learning.materials.deleteLabel", { title: material.title }),
      commit: () => runMaterialAction(
        material.id,
        material.title,
        "learning.materials.action.delete",
        () => deleteMaterial(material.id),
        true,
      ),
    });
  }

  return (
    <div className="sidebar">
      <div className="panel sidebar-panel">
        <div className="sidebar-title">{t("learning.materials.heading")}</div>
        {mats.length === 0 && (loading
          ? <AiPending label={t("learning.materials.loading")} />
          : <p style={{ color: "var(--ink-3)", fontSize: 13 }}>{t("learning.materials.empty")}</p>)}
        <div className="mat-list">
          {mats.map(m => (
            <div className="mat-entry" key={m.id}>
              <div className="mat-row">
                <span className="kind-chip">{kindLabel(m.kind, t)}</span>
                {m.source_type === "obsidian" && (
                  <span className="kind-chip" title={m.source_path ?? "Obsidian"}>OBS</span>
                )}
                <span className="mat-title" title={m.original_filename ?? m.title}>{m.title}</span>
                {m.status === "processing" && (
                  <>
                    <span className="status-dot processing" role="img" aria-label={t("learning.materials.analysisRunningAria")} />
                    <span className="quiz-status-msg" role="status" aria-live="polite">
                      {m.retry_chunk_count
                        ? t("learning.materials.retryChunks", {
                            progress: formatNumber(m.progress),
                            count: formatNumber(m.retry_chunk_count),
                          })
                        : `${formatNumber(m.progress)}%`}
                    </span>
                    <button
                      className="retry-btn"
                      title={t("learning.materials.stopAnalysisTitle")}
                      disabled={materialActionId !== null || pendingDelete !== null}
                      onClick={() => doCancelMat(m)}
                    >{t("learning.common.stop")}</button>
                  </>
                )}
                {m.status === "ready" && (
                  <>
                    <span className="status-dot ready" role="img" aria-label={t("learning.materials.readyAria")} />
                    {m.book_status === "processing" && (
                      <>
                        <span
                          className="quiz-status-msg"
                          role="status"
                          aria-live="polite"
                          title={t("learning.materials.problemRegisterTitle")}
                        >
                          {m.book_retry_chunk_count && m.book_error?.includes("오류·미완료")
                            ? t("learning.materials.problemRetryChunks", {
                                progress: formatNumber(m.book_progress ?? 0),
                                count: formatNumber(m.book_retry_chunk_count),
                              })
                            : t("learning.materials.problemProgress", {
                                progress: formatNumber(m.book_progress ?? 0),
                              })}
                        </span>
                        {m.book_file_id && (
                          <button
                            className="retry-btn"
                            disabled={materialActionId !== null || pendingDelete !== null}
                            onClick={() => doCancelBook(m, m.book_file_id!)}
                          >{t("learning.common.stop")}</button>
                        )}
                      </>
                    )}
                    {m.book_status === "error" && m.book_file_id && (
                      <button
                        className="retry-btn"
                        title={locale === "ko" && m.book_error
                          ? m.book_error
                          : t("learning.materials.problemFailed")}
                        disabled={materialActionId !== null || pendingDelete !== null}
                        onClick={() => doRetryBook(m, m.book_file_id!)}
                      >{t("learning.materials.problemRetry")}</button>
                    )}
                  </>
                )}
                {m.status === "error" && (
                  <>
                    <span className="status-dot error" role="img" aria-label={t("learning.materials.analysisErrorAria")} />
                    <button
                      className="retry-btn"
                      disabled={materialActionId !== null || pendingDelete !== null}
                      onClick={() => retry(m)}
                    >{t("learning.materials.retry")}</button>
                  </>
                )}
                <button
                  className="del-btn"
                  aria-label={t("learning.materials.deleteAria", {
                    title: m.title,
                    action: pendingDelete?.key === `material:${m.id}`
                      ? t("learning.common.deletePending")
                      : t("learning.common.delete"),
                  })}
                  disabled={materialActionId !== null || pendingDelete !== null}
                  onClick={() => doDeleteMat(m)}
                >✕</button>
              </div>
              {m.status === "error" && m.error && (
                <div className="mat-error" role="alert">
                  {locale === "ko" ? m.error : t("learning.materials.actionFailed")}
                </div>
              )}
              {m.status === "error" && Boolean(m.retry_chunk_count) && (
                <div className="mat-warning" role="status">
                  {t("learning.materials.chunkWarning", {
                    retry: formatNumber(m.retry_chunk_count ?? 0),
                    total: m.chunk_total === null || m.chunk_total === undefined
                      ? "?"
                      : formatNumber(m.chunk_total),
                  })}
                </div>
              )}
              {m.integrity_warning && !m.integrity_warning.startsWith("페이지 근거 불완전:") && (
                <div className="mat-warning" role="status">
                  {locale === "ko" ? m.integrity_warning : t("learning.materials.integrityWarning")}
                </div>
              )}
              {m.book_status === "error" && (
                <>
                  <div className="mat-error" role="alert">
                    {locale === "ko" && m.book_error
                      ? m.book_error
                      : t("learning.materials.problemFailedHelp")}
                  </div>
                  {Boolean(m.book_retry_chunk_count) && (
                    <div className="mat-warning" role="status">
                      {t("learning.materials.problemChunkWarning", {
                        retry: formatNumber(m.book_retry_chunk_count ?? 0),
                        total: m.book_chunk_total === null || m.book_chunk_total === undefined
                          ? "?"
                          : formatNumber(m.book_chunk_total),
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
        {materialActionError && (
          <div className="mat-error" role="alert">
            <strong>{t("learning.materials.actionFailureTitle", {
              title: materialActionError.title,
              context: t(materialActionError.context),
            })}</strong>
            <div>{materialActionError.message}</div>
            <button
              className="btn sm"
              disabled={materialActionId !== null || pendingDelete !== null}
              onClick={() => runMaterialAction(
                materialActionError.materialId,
                materialActionError.title,
                materialActionError.context,
                materialActionError.retry,
              )}
            >{t("learning.common.retry")}</button>
          </div>
        )}

        <div className="upload-area">
          <label className="file-label">
            {t("learning.materials.add")}
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,application/pdf,image/jpeg,image/png,image/webp,image/gif"
              multiple
              onChange={onFileChange}
              disabled={uploading}
            />
          </label>
          <div className="upload-help">{t("learning.materials.limits")}</div>
          {uploading && (
            <div className="upload-status" role="status" aria-live="polite">
              {t("learning.materials.uploading", { progress: uploadStatus })}
            </div>
          )}
          {uploadErrors.length > 0 && (
            <div className="mat-error" role="alert">
              <strong>{t("learning.materials.failedFiles")}</strong>
              <ul>{uploadErrors.map(error => <li key={error}>{error}</li>)}</ul>
              <div>{t("learning.materials.reselect")}</div>
            </div>
          )}
          <button
            className="btn sm"
            style={{ width: "100%" }}
            onClick={() => setShowTextForm(v => !v)}
            aria-expanded={showTextForm}
            aria-controls="material-text-form"
          >
            {t("learning.materials.addText")}
          </button>
          <div id="material-text-form" className="text-form" hidden={!showTextForm}>
              <input
                className="text-input"
                name="material-title"
                autoComplete="off"
                aria-label={t("learning.materials.textTitleAria")}
                placeholder={t("learning.materials.textTitlePlaceholder")}
                value={textTitle}
                onChange={e => setTextTitle(e.target.value)}
              />
              <textarea
                className="text-input"
                name="material-content"
                autoComplete="off"
                aria-label={t("learning.materials.textContentAria")}
                placeholder={t("learning.materials.textContentPlaceholder")}
                value={textBody}
                onChange={e => setTextBody(e.target.value)}
              />
              {textError && <div className="mat-error" role="alert">{textError}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn sm primary" style={{ flex: 1 }} onClick={submitText} disabled={uploading}>
                  {t("learning.common.save")}
                </button>
                <button className="btn sm" onClick={() => setShowTextForm(false)}>
                  {t("learning.common.cancel")}
                </button>
              </div>
          </div>
        </div>
      </div>
    </div>
  );
}
