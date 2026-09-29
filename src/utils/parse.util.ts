interface ParseBoolProps {
  value?: string;
  fallback: boolean;
}
export const parseBool = ({ value, fallback }: ParseBoolProps): boolean => {
  if (value === undefined) return fallback;

  const lowered = value.toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(lowered)) return true;
  if (['false', '0', 'no', 'n'].includes(lowered)) return false;

  return fallback;
};
