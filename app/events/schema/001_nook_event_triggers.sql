-- Notify function for nook events via pg_notify.
-- Reusable across tables — event name passed as trigger argument.
-- Payload: {"nook_id": "...", "event": "...", "table": "...", "id": "..."}
CREATE OR REPLACE FUNCTION global.notify_nook_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('nook_events', json_build_object(
    'nook_id', COALESCE(NEW.nook_id, OLD.nook_id),
    'event',   TG_ARGV[0],
    'table',   TG_TABLE_NAME,
    'id',      COALESCE(NEW.id, OLD.id)
  )::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Notes: insert, update, delete
CREATE TRIGGER notify_note_change
  AFTER INSERT OR UPDATE OR DELETE ON global.notes
  FOR EACH ROW EXECUTE FUNCTION global.notify_nook_event('note_changed');

-- Note types: insert, update, delete
CREATE TRIGGER notify_type_change
  AFTER INSERT OR UPDATE OR DELETE ON global.note_types
  FOR EACH ROW EXECUTE FUNCTION global.notify_nook_event('types_changed');

-- Type attributes: insert, update, delete
CREATE TRIGGER notify_attr_change
  AFTER INSERT OR UPDATE OR DELETE ON global.type_attributes
  FOR EACH ROW EXECUTE FUNCTION global.notify_nook_event('types_changed');

-- Note links
CREATE TRIGGER notify_link_change
  AFTER INSERT OR UPDATE OR DELETE ON global.note_links
  FOR EACH ROW EXECUTE FUNCTION global.notify_nook_event('links_changed');
