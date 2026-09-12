/**
 * Name data for synthetic patient/consultant generation.
 * Common UK first and last names.
 */

export const FIRST_NAMES = [
  'Oliver', 'George', 'Arthur', 'Noah', 'Muhammad', 'Leo', 'Oscar', 'Harry',
  'Archie', 'Jack', 'Henry', 'Charlie', 'Freddie', 'Theo', 'Thomas',
  'Olivia', 'Amelia', 'Isla', 'Ava', 'Mia', 'Ivy', 'Lily', 'Isabella',
  'Rosie', 'Sophie', 'Emily', 'Ella', 'Grace', 'Phoebe', 'Evie',
  'James', 'William', 'Edward', 'Alexander', 'Daniel', 'Samuel', 'Joseph',
  'Margaret', 'Elizabeth', 'Dorothy', 'Patricia', 'Barbara', 'Helen', 'Susan',
  'David', 'Robert', 'Michael', 'John', 'Richard', 'Peter', 'Andrew',
  'Sarah', 'Emma', 'Hannah', 'Charlotte', 'Jessica', 'Rebecca', 'Laura',
] as const;

export const LAST_NAMES = [
  'Smith', 'Jones', 'Williams', 'Taylor', 'Brown', 'Davies', 'Evans',
  'Wilson', 'Thomas', 'Roberts', 'Johnson', 'Lewis', 'Walker', 'Robinson',
  'Wood', 'Thompson', 'White', 'Watson', 'Jackson', 'Wright', 'Green',
  'Harris', 'Cooper', 'King', 'Lee', 'Martin', 'Clarke', 'James',
  'Morgan', 'Hughes', 'Edwards', 'Hill', 'Moore', 'Clark', 'Harrison',
  'Scott', 'Young', 'Morris', 'Hall', 'Ward', 'Turner', 'Carter',
  'Phillips', 'Mitchell', 'Patel', 'Adams', 'Campbell', 'Anderson', 'Allen',
  'Cook', 'Bailey', 'Palmer', 'Stevens', 'Bell', 'Richardson', 'Collins',
] as const;

export const WARD_SPECIALTIES = [
  'General Medicine',
  'General Surgery',
  'Orthopaedics',
  'Cardiology',
  'Respiratory',
  'Gastroenterology',
  'Neurology',
  'Paediatrics',
  'Maternity',
  'ICU',
  'HDU',
  'Oncology',
  'Haematology',
  'Geriatrics',
  'Emergency Assessment',
] as const;

export const WARD_NAME_PREFIXES = [
  'Nightingale', 'Fleming', 'Lister', 'Jenner', 'Harvey', 'Curie',
  'Darwin', 'Pasteur', 'Salk', 'Barnard', 'Hippocrates', 'Galen',
  'Vesalius', 'Hunter', 'Osler', 'Broca', 'Koch', 'Semmelweis',
  'Garrett Anderson', 'Seacole', 'Cavell', 'Mandela', 'Bevan', 'Pankhurst',
  'Turing', 'Franklin', 'Hodgkin', 'Crick', 'Watson', 'Wilkins',
] as const;

export const DISCHARGE_NOTES = [
  'Patient recovered well. Follow-up in 2 weeks.',
  'Discharged with medication. GP follow-up required.',
  'Patient stable. Outpatient appointment scheduled.',
  'Condition improved. Community nursing referral made.',
  'Discharged to care home. Social services notified.',
  'Patient self-discharged against medical advice.',
  'Transfer to specialist unit for ongoing care.',
  'Palliative care pathway initiated.',
  null,
  null,
  null,
] as const;
