-- Sale-side Tickler number on Purchase & Sale files (file_number holds the purchase number).
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS selling_file_number text;
CREATE INDEX IF NOT EXISTS deals_selling_file_number_idx ON public.deals (selling_file_number);
