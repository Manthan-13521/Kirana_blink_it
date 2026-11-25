CREATE TABLE media_usage (
  id INTEGER PRIMARY KEY CHECK(id=1),
  bytes INTEGER NOT NULL CHECK(bytes>=0),
  files INTEGER NOT NULL CHECK(files>=0),
  day INTEGER NOT NULL,
  uploads INTEGER NOT NULL
);
INSERT INTO media_usage SELECT 1,COALESCE(SUM(size),0),COUNT(*),0,0 FROM media;

CREATE TRIGGER media_limit BEFORE INSERT ON media BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM media_usage WHERE id=1 AND (
    bytes+NEW.size>201326592 OR files>=6500 OR (day=NEW.created_at/86400 AND uploads>=300)))
    THEN RAISE(ABORT,'media_limit') END;
END;
CREATE TRIGGER media_usage_add AFTER INSERT ON media BEGIN
  UPDATE media_usage SET bytes=bytes+NEW.size,files=files+1,
    uploads=CASE WHEN day=NEW.created_at/86400 THEN uploads+1 ELSE 1 END,
    day=NEW.created_at/86400 WHERE id=1;
END;
CREATE TRIGGER media_usage_subtract AFTER DELETE ON media BEGIN
  UPDATE media_usage SET bytes=bytes-OLD.size,files=files-1 WHERE id=1;
END;
