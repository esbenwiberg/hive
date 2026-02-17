import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "../db/connection.js";

// Augment express-session to include our user object
declare module "express-session" {
  interface SessionData {
    user: {
      id: number;
      entraOid: string;
      email: string;
      displayName: string;
      role: string;
    };
  }
}

const PgStore = connectPgSimple(session);

const sessionMiddleware = session({
  store: new PgStore({
    pool,
    tableName: "sessions",
    createTableIfMissing: false,
  }),
  secret: process.env.SESSION_SECRET ?? "change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
  },
});

export default sessionMiddleware;
