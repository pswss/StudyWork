-- 채팅 메시지에 질문 모드 기록 (materials | general). 기존 행은 NULL(뱃지 없음).
ALTER TABLE messages ADD COLUMN mode TEXT;
