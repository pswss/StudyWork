import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectRawRecords,
  DEFAULT_SLICES,
  makeRequestBody,
  parsePage,
  selectEntries,
  SUBJECTS,
  type RawPaper,
  type Slice,
} from "../scripts/ebsi-manifest";

const slice: Slice = { key: "D300:2025", targetCd: "D300", year: 2025, arOrd: "1", subjectIds: "x" };

function row({
  title,
  paperId,
  irecord = "202511133",
  problem = `/20251113/go3/${paperId}_mun.pdf`,
  solution = `/20251113/go3/${paperId}_hsj.pdf`,
  even = "0",
}: {
  title: string;
  paperId: string;
  irecord?: string;
  problem?: string;
  solution?: string;
  even?: string;
}): string {
  return `<div class="qus_box kor">
    <div class="qus_tit">${title.replaceAll(" ", "&nbsp;")}</div>
    <button onclick="goDownLoadP('${problem}', '/log', '${irecord}', '301', '4', '140118', '${even}', '/file', '${paperId}');">문제</button>
    <button onclick="goDownLoadH('${solution}', '/log', '${irecord}', '301', '4', '140118', '${even}', '/file');">해설</button>
  </div>`;
}

function page(rows: string[], totalRows = rows.length, totalPages = 1): string {
  const pages = Array.from({ length: totalPages }, (_, index) => `<a href='javascript:goPage(${index + 1})'>${index + 1}</a>`).join("");
  return `<p>총 <em class="tot">${totalRows}개</em>가 검색 되었습니다.</p>${rows.join("")}<div>${pages}</div>`;
}

function raw(overrides: Partial<RawPaper> & Pick<RawPaper, "paperId" | "rawSubject" | "subject">): RawPaper {
  const administrationDate = overrides.administrationDate ?? "2025-11-13";
  const grade = overrides.grade ?? 3;
  const examTitle = overrides.examTitle ?? "2026학년도 대학수학능력시험";
  return {
    sliceKey: overrides.sliceKey ?? `D${grade}00:${administrationDate.slice(0, 4)}`,
    targetCd: overrides.targetCd ?? (grade === 1 ? "D100" : grade === 2 ? "D200" : "D300"),
    queryYear: overrides.queryYear ?? Number(administrationDate.slice(0, 4)),
    paperId: overrides.paperId,
    irecord: overrides.irecord ?? `${administrationDate.replaceAll("-", "")}${grade}`,
    administrationDate,
    administrationYear: overrides.administrationYear ?? Number(administrationDate.slice(0, 4)),
    month: overrides.month ?? Number(administrationDate.slice(5, 7)),
    grade,
    examKind: overrides.examKind ?? "csat",
    subject: overrides.subject,
    rawSubject: overrides.rawSubject,
    examTitle,
    rawTitle: overrides.rawTitle ?? `${examTitle} ${overrides.rawSubject}`,
    form: overrides.form ?? null,
    isEven: overrides.isEven ?? false,
    sourcePageUrl: overrides.sourcePageUrl ?? "https://www.ebsi.co.kr/ebs/xip/xipc/previousPaperList.ebs?targetCd=D300",
    problemPdfUrl: overrides.problemPdfUrl ?? `https://wdown.ebsi.co.kr/W61001/01exam/${overrides.paperId}_mun.pdf`,
    solutionPdfUrl: overrides.solutionPdfUrl ?? `https://wdown.ebsi.co.kr/W61001/01exam/${overrides.paperId}_hsj.pdf`,
  };
}

describe("EBSi manifest parser", () => {
  it("parses exact identity and official PDF links from AJAX HTML", () => {
    const result = parsePage(page([
      row({ title: "2026학년도 대학수학능력시험 언어와 매체 홀수형", paperId: "26111848" }),
    ], 1, 3), slice);

    expect(result.totalPages).toBe(3);
    expect(result.records[0]).toMatchObject({
      paperId: "26111848",
      irecord: "202511133",
      administrationDate: "2025-11-13",
      grade: 3,
      examKind: "csat",
      subject: "국어",
      rawSubject: "언어와 매체",
      examTitle: "2026학년도 대학수학능력시험",
      rawTitle: "2026학년도 대학수학능력시험 언어와 매체 홀수형",
      form: "odd",
      problemPdfUrl: "https://wdown.ebsi.co.kr/W61001/01exam/20251113/go3/26111848_mun.pdf",
      solutionPdfUrl: "https://wdown.ebsi.co.kr/W61001/01exam/20251113/go3/26111848_hsj.pdf",
    });
  });

  it("posts every AJAX parameter and all twelve hidden month values", () => {
    const body = makeRequestBody(slice, 7);
    expect(Object.fromEntries(body)).toEqual({
      targetCd: "D300",
      yearList: "2025",
      monthList: "01,02,03,04,05,06,07,08,09,10,11,12",
      arOrd: "1",
      subjIdList: "x",
      sort: "recent",
      currentPage: "7",
    });
  });

  it("queries only the four requested subjects", () => {
    expect(SUBJECTS).toEqual(["국어", "수학", "통합사회", "통합과학"]);
    expect(DEFAULT_SLICES.find((item) => item.targetCd === "D300")?.arOrd).toBe("1,2");
    expect(DEFAULT_SLICES.find((item) => item.targetCd === "D200")?.arOrd).toBe("1,2,5,6");
  });

  it("keeps historical math tracks but chooses one current elective and odd form", () => {
    const rows = [
      raw({ paperId: "1", subject: "국어", rawSubject: "화법과 작문" }),
      raw({ paperId: "2", subject: "국어", rawSubject: "언어와 매체" }),
      raw({ paperId: "3", subject: "국어", rawSubject: "언어와 매체", form: "even", isEven: true }),
      raw({ paperId: "4", subject: "수학", rawSubject: "확률과 통계" }),
      raw({ paperId: "5", subject: "수학", rawSubject: "미적분" }),
      raw({ paperId: "6", subject: "수학", rawSubject: "기하" }),
      raw({ paperId: "7", subject: "수학", rawSubject: "수학가형", administrationDate: "2020-12-03", administrationYear: 2020, irecord: "202012033" }),
      raw({ paperId: "8", subject: "수학", rawSubject: "수학나형", administrationDate: "2020-12-03", administrationYear: 2020, irecord: "202012033" }),
    ];

    expect(selectEntries(rows).map((entry) => entry.paperId)).toEqual(["7", "8", "2", "5"]);
  });

  it("applies grade, year, kind, integrated-subject, and cutoff scope", () => {
    const rows = [
      raw({ paperId: "1", grade: 1, subject: "국어", rawSubject: "국어", examKind: "mock", administrationDate: "2025-03-01" }),
      raw({ paperId: "2", grade: 1, subject: "통합과학", rawSubject: "통합과학", examKind: "mock", administrationDate: "2025-03-01" }),
      raw({ paperId: "3", grade: 2, subject: "국어", rawSubject: "국어", examKind: "mock", administrationDate: "2026-09-01" }),
      raw({ paperId: "4", grade: 3, subject: "국어", rawSubject: "국어", examKind: "mock", administrationDate: "2016-06-01" }),
      raw({ paperId: "5", grade: 3, subject: "국어", rawSubject: "국어", examKind: "csat", administrationDate: "2016-11-17", administrationYear: 2016 }),
    ];

    expect(selectEntries(rows).map((entry) => entry.paperId)).toEqual(["5", "2"]);
  });

  it("resumes after the last atomically checkpointed page", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ebsi-manifest-"));
    const state = join(dir, "state.json");
    const testSlice: Slice = { key: "D100:2025", targetCd: "D100", year: 2025, arOrd: "5", subjectIds: "x" };
    let fail = true;
    const calls: number[] = [];
    const fetchPage = async (_source: Slice, number: number) => {
      calls.push(number);
      if (number === 2 && fail) throw new Error("interrupted");
      return number === 1
        ? page([row({ title: "고1 3월 학평(서울) 통합사회", paperId: "11", irecord: "202503261" })], 2, 2)
        : page([row({ title: "고1 3월 학평(서울) 통합과학", paperId: "12", irecord: "202503261" })], 2, 2);
    };

    await expect(collectRawRecords([testSlice], state, fetchPage)).rejects.toThrow("interrupted");
    fail = false;
    const records = await collectRawRecords([testSlice], state, fetchPage);

    expect(calls).toEqual([1, 2, 2]);
    expect(records.map((record) => record.paperId)).toEqual(["11", "12"]);
    expect(JSON.parse(await readFile(state, "utf8")).slices["D100:2025"].completedPages).toEqual([1, 2]);
  });
});
