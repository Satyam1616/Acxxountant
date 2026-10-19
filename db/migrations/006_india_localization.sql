INSERT INTO currencies (code, minor_units)
VALUES ('INR', 2)
ON CONFLICT (code) DO NOTHING;
