-- Crew can be offered shifts before their onboarding paperwork is done, unless a company asks otherwise
-- (Labor rules > Building the crew). Switch the hold off everywhere so that is the starting point.
UPDATE staffing_settings SET onboarding_block = false WHERE onboarding_block;
