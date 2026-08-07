import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const SOURCE_RECORD_CUTOFF_DATE = "2026-08-07";
export const SUBJECTS = ["국어", "수학", "통합사회", "통합과학"] as const;
export type Subject = (typeof SUBJECTS)[number];
export type TargetCd = "D100" | "D200" | "D300";

const EBSI_ORIGIN = "https://www.ebsi.co.kr";
const LIST_ENDPOINT = `${EBSI_ORIGIN}/ebs/xip/xipc/previousPaperListAjax.ajax`;
const DOWNLOAD_ORIGIN = "https://wdown.ebsi.co.kr/W61001/01exam";
// The current EBSi form omits valid hidden values such as May and July.
const MONTHS = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0")).join(",");

export interface Slice {
  key: string;
  targetCd: TargetCd;
  year: number;
  arOrd: string;
  subjectIds: string;
}

export interface RawPaper {
  sliceKey: string;
  targetCd: TargetCd;
  queryYear: number;
  paperId: string;
  irecord: string;
  sourceRecordDate: string;
  sourceRecordYear: number;
  sourceRecordMonth: number;
  grade: 1 | 2 | 3;
  examKind: "mock" | "csat";
  subject: Subject;
  rawSubject: string;
  examTitle: string;
  rawTitle: string;
  form: "odd" | "even" | null;
  isEven: boolean;
  sourcePageUrl: string;
  problemPdfUrl: string | null;
  solutionPdfUrl: string | null;
}

export interface ManifestEntry {
  id: string;
  paperId: string;
  irecord: string;
  sourceRecordDate: string;
  sourceRecordYear: number;
  sourceRecordMonth: number;
  grade: 1 | 2 | 3;
  examKind: "mock" | "csat";
  subject: Subject;
  variant: string | null;
  form: "odd" | "even" | null;
  examTitle: string;
  rawTitle: string;
  sourcePageUrl: string;
  problemPdfUrl: string;
  solutionPdfUrl: string;
}

interface SliceProgress {
  totalPages: number;
  totalRows: number;
  completedPages: number[];
}

interface Checkpoint {
  schemaVersion: 2;
  signature: string;
  slices: Record<string, SliceProgress>;
  records: RawPaper[];
}

export interface PageResult {
  totalPages: number;
  totalRows: number;
  records: RawPaper[];
}

export interface Manifest {
  schemaVersion: 2;
  generatedAt: string;
  sourceRecordCutoffDate: string;
  source: {
    listEndpoint: string;
    downloadOrigin: string;
    dateSemantics: "sourceRecordDate is derived from EBSi irecord and is not a verified exam administration date";
  };
  selection: {
    subjects: readonly Subject[];
    currentKoreanVariant: "언어와 매체";
    currentMathVariant: "미적분";
    csatForm: "odd";
    cutoffBasis: "sourceRecordDate";
  };
  summary: ReturnType<typeof summarize>;
  entries: ManifestEntry[];
}

const CORE_D300 = [
  "140117", "140118", "korPast",
  "140119", "140120", "140121", "mathPast",
].join(",");
const CORE_D200 = ["17022", "140111", "140220", "140221"].join(",");
const INTEGRATED_D100 = "140072,140073";

export const DEFAULT_SLICES: Slice[] = [
  ...range(2016, 2026).map((year) => slice("D300", year, "1,2", CORE_D300)),
  ...range(2017, 2026).map((year) => slice("D200", year, "1,2,5,6", CORE_D200)),
  ...range(2017, 2026).map((year) => slice("D100", year, "5,6", INTEGRATED_D100)),
];

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function slice(targetCd: TargetCd, year: number, arOrd: string, subjectIds: string): Slice {
  return { key: `${targetCd}:${year}`, targetCd, year, arOrd, subjectIds };
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", middot: "·", nbsp: " ", quot: '"',
  };
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
}

function extractCallArgs(block: string, functionName: string): string[] | null {
  const call = block.match(new RegExp(`onclick="${functionName}\\(([^\"]*)\\)`));
  if (!call) return null;
  return [...call[1].matchAll(/'((?:\\.|[^'\\])*)'/g)].map((match) =>
    decodeHtml(match[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\")),
  );
}

const SUBJECT_VARIANTS: Array<[string, Subject, string]> = [
  ["확률과 통계", "수학", "확률과 통계"],
  ["언어와 매체", "국어", "언어와 매체"],
  ["화법과 작문", "국어", "화법과 작문"],
  ["수학(가형)", "수학", "수학가형"],
  ["수학(나형)", "수학", "수학나형"],
  ["수학 가형", "수학", "수학가형"],
  ["수학 나형", "수학", "수학나형"],
  ["통합사회", "통합사회", "통합사회"],
  ["통합과학", "통합과학", "통합과학"],
  ["수학가형", "수학", "수학가형"],
  ["수학나형", "수학", "수학나형"],
  ["미적분", "수학", "미적분"],
  ["기하", "수학", "기하"],
  ["국어", "국어", "국어"],
  ["수학", "수학", "수학"],
];

function parseTitle(rawTitle: string): {
  subject: Subject;
  rawSubject: string;
  examTitle: string;
  form: "odd" | "even" | null;
} {
  const form = rawTitle.endsWith("짝수형") ? "even" : rawTitle.endsWith("홀수형") ? "odd" : null;
  const withoutForm = rawTitle.replace(/\s*(?:홀수형|짝수형)$/, "").trim();
  for (const [suffix, subject, rawSubject] of SUBJECT_VARIANTS) {
    if (!withoutForm.endsWith(suffix)) continue;
    const examTitle = withoutForm.slice(0, -suffix.length).trim();
    if (!examTitle) break;
    return { subject, rawSubject, examTitle, form };
  }
  throw new Error(`Unknown EBSi subject/title: ${rawTitle}`);
}

function pdfUrl(value: string | undefined): string | null {
  if (!value) return null;
  const url = value.startsWith("https://")
    ? value
    : value.startsWith("//")
      ? `https:${value}`
      : `${DOWNLOAD_ORIGIN}${value.startsWith("/") ? "" : "/"}${value}`;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "wdown.ebsi.co.kr" && /\.pdf$/i.test(parsed.pathname)
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function gradeFor(targetCd: TargetCd): 1 | 2 | 3 {
  return targetCd === "D100" ? 1 : targetCd === "D200" ? 2 : 3;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validateTitleYear(
  rawTitle: string,
  examKind: "mock" | "csat",
  sourceRecordYear: number,
  queryYear: number,
): void {
  if (sourceRecordYear !== queryYear) {
    throw new Error(`${rawTitle}: source record year ${sourceRecordYear} differs from query year ${queryYear}`);
  }
  if (examKind === "csat") {
    const academicYear = rawTitle.match(/(\d{4})학년도\s*대학수학능력시험/)?.[1];
    if (!academicYear || Number(academicYear) !== sourceRecordYear + 1) {
      throw new Error(`${rawTitle}: CSAT academic year does not match source record year ${sourceRecordYear}`);
    }
    return;
  }
  const calendarYear = rawTitle.match(/\b(20\d{2})년(?!도)/)?.[1];
  if (calendarYear && Number(calendarYear) !== sourceRecordYear) {
    throw new Error(`${rawTitle}: visible year does not match source record year ${sourceRecordYear}`);
  }
}

export function parsePage(html: string, source: Slice): PageResult {
  const totalMatch = html.match(/총\s*<em[^>]*>([\d,]+)개<\/em>/);
  if (!totalMatch) throw new Error(`${source.key}: EBSi total count missing`);
  const totalRows = Number(totalMatch[1].replaceAll(",", ""));
  const pageNumbers = [...html.matchAll(/goPage\((\d+)\)/g)].map((match) => Number(match[1]));
  const totalPages = Math.max(1, ...pageNumbers);
  const records: RawPaper[] = [];

  for (const block of html.split(/<div class="qus_box\b[^>]*>/).slice(1)) {
    const titleMatch = block.match(/<div class="qus_tit">([\s\S]*?)<\/div>/);
    if (!titleMatch) continue;
    const rawTitle = decodeHtml(titleMatch[1]);
    const problem = extractCallArgs(block, "goDownLoadP");
    if (!problem || problem.length < 9) throw new Error(`${source.key}: problem metadata missing for ${rawTitle}`);
    const solution = extractCallArgs(block, "goDownLoadH");
    const paperId = problem[8];
    const irecord = problem[2];
    if (!/^\d+$/.test(paperId) || !/^\d{8,}$/.test(irecord)) {
      throw new Error(`${source.key}: invalid paperId/irecord for ${rawTitle}`);
    }
    const sourceRecordDate = `${irecord.slice(0, 4)}-${irecord.slice(4, 6)}-${irecord.slice(6, 8)}`;
    if (!validDate(sourceRecordDate)) throw new Error(`${source.key}: invalid source record date ${sourceRecordDate}`);
    const sourceRecordYear = Number(irecord.slice(0, 4));
    const parsedTitle = parseTitle(rawTitle);
    const examKind = parsedTitle.examTitle.includes("대학수학능력시험") ? "csat" : "mock";
    validateTitleYear(rawTitle, examKind, sourceRecordYear, source.year);
    records.push({
      sliceKey: source.key,
      targetCd: source.targetCd,
      queryYear: source.year,
      paperId,
      irecord,
      sourceRecordDate,
      sourceRecordYear,
      sourceRecordMonth: Number(irecord.slice(4, 6)),
      grade: gradeFor(source.targetCd),
      examKind,
      ...parsedTitle,
      rawTitle,
      isEven: problem[6] === "1" || parsedTitle.form === "even",
      sourcePageUrl: `${EBSI_ORIGIN}/ebs/xip/xipc/previousPaperList.ebs?targetCd=${source.targetCd}`,
      problemPdfUrl: pdfUrl(problem[0]),
      solutionPdfUrl: pdfUrl(solution?.[0]),
    });
  }
  if (totalRows > 0 && records.length === 0) throw new Error(`${source.key}: EBSi returned rows that could not be parsed`);
  return { totalPages, totalRows, records };
}

function inScope(row: RawPaper, sourceRecordCutoffDate: string): boolean {
  if (row.sourceRecordDate > sourceRecordCutoffDate) return false;
  if (row.examKind === "csat") return row.grade === 3 && row.sourceRecordYear >= 2016 && row.sourceRecordYear <= 2025;
  if (row.sourceRecordYear < 2017 || row.sourceRecordYear > 2026) return false;
  if (row.grade === 1) return row.subject === "통합사회" || row.subject === "통합과학";
  return row.grade === 2 || row.grade === 3;
}

function variantGroup(row: RawPaper): string {
  return row.subject === "수학" && (row.rawSubject === "수학가형" || row.rawSubject === "수학나형")
    ? row.rawSubject
    : "canonical";
}

function variantPriority(row: RawPaper): number {
  const priorities: Record<string, number> = {
    국어: 0,
    "언어와 매체": 1,
    "화법과 작문": 2,
    수학: 0,
    미적분: 1,
    "확률과 통계": 2,
    기하: 3,
    수학가형: 0,
    수학나형: 0,
  };
  return priorities[row.rawSubject] ?? 0;
}

export function selectEntries(rows: RawPaper[], sourceRecordCutoffDate = SOURCE_RECORD_CUTOFF_DATE): ManifestEntry[] {
  if (!validDate(sourceRecordCutoffDate)) throw new Error(`Invalid source record cutoff date: ${sourceRecordCutoffDate}`);
  const selected = new Map<string, RawPaper>();
  for (const row of rows) {
    if (!inScope(row, sourceRecordCutoffDate) || row.isEven) continue;
    const key = [row.irecord, row.grade, row.examTitle, row.subject, variantGroup(row)].join("|");
    const current = selected.get(key);
    if (!current || variantPriority(row) < variantPriority(current)) selected.set(key, row);
  }

  const entries = [...selected.values()].map((row): ManifestEntry => {
    if (!row.problemPdfUrl || !row.solutionPdfUrl) {
      throw new Error(`Official PDF pair incomplete: ${row.rawTitle} (${row.paperId})`);
    }
    return {
      id: `ebsi:${row.paperId}`,
      paperId: row.paperId,
      irecord: row.irecord,
      sourceRecordDate: row.sourceRecordDate,
      sourceRecordYear: row.sourceRecordYear,
      sourceRecordMonth: row.sourceRecordMonth,
      grade: row.grade,
      examKind: row.examKind,
      subject: row.subject,
      variant: row.rawSubject === row.subject ? null : row.rawSubject,
      form: row.form,
      examTitle: row.examTitle,
      rawTitle: row.rawTitle,
      sourcePageUrl: row.sourcePageUrl,
      problemPdfUrl: row.problemPdfUrl,
      solutionPdfUrl: row.solutionPdfUrl,
    };
  });

  const subjectOrder = new Map(SUBJECTS.map((subject, index) => [subject, index]));
  entries.sort((a, b) =>
    a.sourceRecordDate.localeCompare(b.sourceRecordDate)
      || a.grade - b.grade
      || a.examTitle.localeCompare(b.examTitle, "ko")
      || (subjectOrder.get(a.subject) ?? 99) - (subjectOrder.get(b.subject) ?? 99)
      || (a.variant ?? "").localeCompare(b.variant ?? "", "ko"),
  );
  assertUnique(entries, "id");
  assertUnique(entries, "problemPdfUrl");
  assertUnique(entries, "solutionPdfUrl");
  return entries;
}

function assertUnique(entries: ManifestEntry[], field: "id" | "problemPdfUrl" | "solutionPdfUrl"): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry[field])) throw new Error(`Duplicate ${field}: ${entry[field]}`);
    seen.add(entry[field]);
  }
}

function groupEntries(
  entries: ManifestEntry[],
  key: (entry: ManifestEntry) => string,
): Map<string, ManifestEntry[]> {
  const groups = new Map<string, ManifestEntry[]>();
  for (const entry of entries) groups.set(key(entry), [...(groups.get(key(entry)) ?? []), entry]);
  return groups;
}

function assertSubjectCounts(
  label: string,
  entries: ManifestEntry[],
  expected: Partial<Record<Subject, number>>,
): void {
  for (const subject of SUBJECTS) {
    const actual = entries.filter((entry) => entry.subject === subject).length;
    const wanted = expected[subject] ?? 0;
    if (actual !== wanted) throw new Error(`${label}: ${subject} expected ${wanted}, got ${actual}`);
  }
}

function assertVariants(label: string, entries: ManifestEntry[], subject: Subject, expected: Array<string | null>): void {
  const actual = entries
    .filter((entry) => entry.subject === subject)
    .map((entry) => entry.variant)
    .sort((a, b) => (a ?? "").localeCompare(b ?? "", "ko"));
  const wanted = [...expected].sort((a, b) => (a ?? "").localeCompare(b ?? "", "ko"));
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label}: ${subject} variants expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
  }
}

function expectedMockIdentities(grade: 1 | 2 | 3, sourceRecordYear: number): number {
  if (grade === 1) return sourceRecordYear === 2017 ? 0 : sourceRecordYear === 2026 ? 2 : 4;
  if (grade === 2) return sourceRecordYear === 2026 ? 2 : 4;
  return sourceRecordYear === 2026 ? 4 : 6;
}

export function validateCoverage(entries: ManifestEntry[]): void {
  const csat = entries.filter((entry) => entry.examKind === "csat");
  for (const sourceRecordYear of range(2016, 2025)) {
    const yearly = csat.filter((entry) => entry.sourceRecordYear === sourceRecordYear);
    const identities = new Set(yearly.map((entry) => `${entry.irecord}|${entry.examTitle}`));
    if (identities.size !== 1) throw new Error(`CSAT ${sourceRecordYear}: expected 1 identity, got ${identities.size}`);
    if (yearly.some((entry) => entry.form !== "odd")) throw new Error(`CSAT ${sourceRecordYear}: odd form required`);
    const historical = sourceRecordYear <= 2020;
    assertSubjectCounts(`CSAT ${sourceRecordYear}`, yearly, { 국어: 1, 수학: historical ? 2 : 1 });
    assertVariants(`CSAT ${sourceRecordYear}`, yearly, "국어", [historical ? null : "언어와 매체"]);
    assertVariants(`CSAT ${sourceRecordYear}`, yearly, "수학", historical ? ["수학가형", "수학나형"] : ["미적분"]);
  }
  const csatYears = new Set(csat.map((entry) => entry.sourceRecordYear));
  if (csatYears.size !== 10) throw new Error(`CSAT coverage: expected 10 source record years, got ${csatYears.size}`);

  const mockGroups = groupEntries(
    entries.filter((entry) => entry.examKind === "mock"),
    (entry) => `${entry.irecord}|${entry.grade}|${entry.examTitle}`,
  );
  for (const grade of [1, 2, 3] as const) {
    for (const sourceRecordYear of range(2017, 2026)) {
      const groups = [...mockGroups.values()].filter(
        (group) => group[0].grade === grade && group[0].sourceRecordYear === sourceRecordYear,
      );
      const expectedIdentities = expectedMockIdentities(grade, sourceRecordYear);
      if (groups.length !== expectedIdentities) {
        throw new Error(`Mock grade ${grade} ${sourceRecordYear}: expected ${expectedIdentities} identities, got ${groups.length}`);
      }
      for (const group of groups) {
        const label = `Mock ${group[0].irecord} ${group[0].examTitle}`;
        if (grade === 1) {
          assertSubjectCounts(label, group, { 통합사회: 1, 통합과학: 1 });
          continue;
        }
        const historicalMath = (grade === 2 && sourceRecordYear <= 2019)
          || (grade === 3 && sourceRecordYear <= 2020);
        const expected: Partial<Record<Subject, number>> = { 국어: 1, 수학: historicalMath ? 2 : 1 };
        if (grade === 2 && sourceRecordYear === 2026) {
          expected.통합사회 = 1;
          expected.통합과학 = 1;
        }
        assertSubjectCounts(label, group, expected);
        assertVariants(label, group, "수학", historicalMath ? ["수학가형", "수학나형"] : [grade === 3 ? "미적분" : null]);
        assertVariants(label, group, "국어", [grade === 3 && sourceRecordYear >= 2021 ? "언어와 매체" : null]);
      }
    }
  }
}

function summarize(entries: ManifestEntry[], rawRows: number) {
  const identities = new Set(entries.map((entry) => `${entry.irecord}|${entry.grade}|${entry.examTitle}`));
  const csatIdentities = new Set(
    entries.filter((entry) => entry.examKind === "csat").map((entry) => `${entry.irecord}|${entry.examTitle}`),
  );
  const mockIdentities = new Set(
    entries.filter((entry) => entry.examKind === "mock").map((entry) => `${entry.irecord}|${entry.grade}|${entry.examTitle}`),
  );
  return {
    rawRows,
    entries: entries.length,
    examIdentities: identities.size,
    mockExamIdentities: mockIdentities.size,
    csatIdentities: csatIdentities.size,
    byGrade: Object.fromEntries([1, 2, 3].map((grade) => [grade, entries.filter((entry) => entry.grade === grade).length])),
    bySubject: Object.fromEntries(SUBJECTS.map((subject) => [subject, entries.filter((entry) => entry.subject === subject).length])),
  };
}

export function buildManifest(rows: RawPaper[], generatedAt = new Date().toISOString()): Manifest {
  const entries = selectEntries(rows);
  validateCoverage(entries);
  return {
    schemaVersion: 2,
    generatedAt,
    sourceRecordCutoffDate: SOURCE_RECORD_CUTOFF_DATE,
    source: {
      listEndpoint: LIST_ENDPOINT,
      downloadOrigin: DOWNLOAD_ORIGIN,
      dateSemantics: "sourceRecordDate is derived from EBSi irecord and is not a verified exam administration date",
    },
    selection: {
      subjects: SUBJECTS,
      currentKoreanVariant: "언어와 매체",
      currentMathVariant: "미적분",
      csatForm: "odd",
      cutoffBasis: "sourceRecordDate",
    },
    summary: summarize(entries, rows.length),
    entries,
  };
}

function stateSignature(slices: Slice[]): string {
  return JSON.stringify({
    schemaVersion: 2,
    sourceRecordCutoffDate: SOURCE_RECORD_CUTOFF_DATE,
    endpoint: LIST_ENDPOINT,
    months: MONTHS,
    slices,
  });
}

async function loadCheckpoint(path: string, slices: Slice[]): Promise<Checkpoint> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Checkpoint>;
    if (parsed.schemaVersion !== 2 || parsed.signature !== stateSignature(slices)
      || !parsed.slices || !Array.isArray(parsed.records)) {
      throw new Error(`Checkpoint does not match collector scope: ${path}`);
    }
    return parsed as Checkpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { schemaVersion: 2, signature: stateSignature(slices), slices: {}, records: [] };
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function collectRawRecords(
  slices: Slice[],
  statePath: string,
  fetchPage: (source: Slice, page: number) => Promise<string>,
): Promise<RawPaper[]> {
  const state = await loadCheckpoint(statePath, slices);
  const records = new Map(state.records.map((record) => [record.paperId, record]));

  for (const source of slices) {
    let progress = state.slices[source.key];
    let page = 1;
    while (!progress || page <= progress.totalPages) {
      if (progress?.completedPages.includes(page)) {
        page += 1;
        continue;
      }
      const parsed = parsePage(await fetchPage(source, page), source);
      if (!progress) {
        progress = { totalPages: parsed.totalPages, totalRows: parsed.totalRows, completedPages: [] };
        state.slices[source.key] = progress;
      } else if (progress.totalPages !== parsed.totalPages || progress.totalRows !== parsed.totalRows) {
        throw new Error(`${source.key}: pagination changed during collection`);
      }
      for (const record of parsed.records) records.set(record.paperId, record);
      progress.completedPages.push(page);
      progress.completedPages.sort((a, b) => a - b);
      state.records = [...records.values()];
      await writeJsonAtomic(statePath, state);
      page += 1;
    }
  }

  for (const source of slices) {
    const progress = state.slices[source.key];
    const count = [...records.values()].filter((record) => record.sliceKey === source.key).length;
    if (!progress || progress.completedPages.length !== progress.totalPages || count !== progress.totalRows) {
      throw new Error(`${source.key}: expected ${progress?.totalRows ?? "?"} rows, collected ${count}`);
    }
  }
  return [...records.values()];
}

export async function fetchEbsiPage(source: Slice, page: number): Promise<string> {
  const body = makeRequestBody(source, page);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(LIST_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "text/html, */*;q=0.1",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          referer: `${EBSI_ORIGIN}/ebs/xip/xipc/previousPaperList.ebs?targetCd=${source.targetCd}`,
          "user-agent": "StudyWork EBSi manifest collector/1.0 (official metadata only)",
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(400 * attempt);
    }
  }
  throw new Error(`${source.key} page ${page}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export function makeRequestBody(source: Slice, page: number): URLSearchParams {
  return new URLSearchParams({
    targetCd: source.targetCd,
    yearList: String(source.year),
    monthList: MONTHS,
    arOrd: source.arOrd,
    subjIdList: source.subjectIds,
    sort: "recent",
    currentPage: String(page),
  });
}

function usage(): string {
  return "Usage: npx tsx scripts/ebsi-manifest.ts --out <manifest.json> [--state <checkpoint.json>]";
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  let out = "";
  let state = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      return;
    }
    if (arg === "--out" || arg === "--state") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      if (arg === "--out") out = resolve(value);
      else state = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out) throw new Error(usage());
  if (!state) state = `${out}.state.json`;
  const rows = await collectRawRecords(DEFAULT_SLICES, state, fetchEbsiPage);
  const manifest = buildManifest(rows);
  await writeJsonAtomic(out, manifest);
  console.log(JSON.stringify({ out, state, ...manifest.summary }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
