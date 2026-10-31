/** Discord snowflake <-> time. The top 42 bits are milliseconds since the Discord epoch. */
const DISCORD_EPOCH = 1420070400000n;

export function snowflakeToDate(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

/** Smallest snowflake at or after `date`; usable as an `after=` cursor. */
export function dateToSnowflake(date: Date): string {
  return ((BigInt(date.getTime()) - DISCORD_EPOCH) << 22n).toString();
}
