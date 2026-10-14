-- "Delete conversation" for one person: their copy hides everything up to this message number,
-- and the conversation leaves their list until someone writes again. Others keep the full history.
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS cleared_seq bigint NOT NULL DEFAULT 0;
