import type { LocalDB } from "./localdb";

/**
 * Convert jobs that cannot survive a process restart into explicit recoverable
 * states.  This keeps the UI from polling forever and re-queues material-linked
 * problem extraction instead of merely labelling it "automatic retry".
 */
export async function recoverInterruptedJobs(db: LocalDB): Promise<void> {
  await db.batch([
    db.prepare(
      `UPDATE materials SET pending_to_book = 0, book_processing = 0
       WHERE book_processing != 0
         AND book_id IN (
           SELECT book_id FROM book_files WHERE error = '사용자 중단'
         )`
    ),
    db.prepare(
      `UPDATE materials SET pending_to_book = 1, book_processing = 0
       WHERE book_processing != 0
          OR book_id IN (SELECT book_id FROM book_files WHERE status = 'processing')`
    ),
    db.prepare(
      `UPDATE materials
       SET status = 'error',
           error = COALESCE(error, '서버 재시작으로 중단됨'),
           retry_chunk_count = MAX(
             0,
             chunk_total - (
               SELECT COUNT(*) FROM material_extraction_chunks
               WHERE material_id = materials.id
             )
           )
       WHERE status = 'processing'`
    ),
    db.prepare(
      `UPDATE book_files
       SET status = 'error', error = '서버 재시작으로 중단됨',
           retry_chunk_count = MAX(
             0,
             chunk_total - (
               SELECT COUNT(*) FROM book_extraction_chunks
               WHERE file_id = book_files.id
             )
           )
       WHERE status = 'processing'`
    ),
    db.prepare("UPDATE notes SET status = 'error' WHERE status = 'processing'"),
    db.prepare(
      `UPDATE ai_jobs
       SET status = 'error', error = '서버 재시작으로 작업이 중단되었습니다. 다시 시도해 주세요.',
           updated_at = datetime('now')
       WHERE status = 'processing'`
    ),
  ]);
}
