// ユーザー・組織・設備の一覧（1時間キャッシュ）
import { SoapClient, xmlEscape } from "./soap.js";

export interface User {
  id: string;
  name: string;
  loginName?: string;
  email?: string;
  primaryOrganization?: string;
  organizations: string[];
}
export interface Organization {
  id: string;
  name: string;
  memberIds: string[];
}
export interface Facility {
  id: string;
  name: string;
  description?: string;
}

const asArray = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const TTL_MS = 60 * 60 * 1000;
const CHUNK = 100;

/** 名前の比較用：空白・全角半角・大小文字・括弧の差をならす */
export function normalize(s: string): string {
  return (s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　()（）・]/g, "");
}

export class Directory {
  private users?: { at: number; list: User[] };
  private orgs?: { at: number; list: Organization[] };
  private facilities?: { at: number; list: Facility[] };
  private myId?: string;

  constructor(private soap: SoapClient) {}

  async loginUserId(): Promise<string> {
    if (!this.myId) {
      const r = await this.soap.call("Util", "UtilGetLoginUserId");
      const id = asArray<any>(r.user_id)[0];
      this.myId = String(typeof id === "object" ? id["#text"] : id);
    }
    return this.myId;
  }

  private async fetchByIds(
    service: string,
    versionsMethod: string,
    itemTag: string,
    byIdMethod: string,
    idTag: string,
  ): Promise<any> {
    const v = await this.soap.call(service, versionsMethod);
    const ids = asArray<any>(v[itemTag])
      .filter((x) => x.operation !== "remove")
      .map((x) => String(x.id));
    const results: any[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const inner = ids
        .slice(i, i + CHUNK)
        .map((id) => `<${idTag}>${xmlEscape(id)}</${idTag}>`)
        .join("");
      results.push(await this.soap.call(service, byIdMethod, "", inner));
    }
    return results;
  }

  async listUsers(): Promise<User[]> {
    if (this.users && Date.now() - this.users.at < TTL_MS) return this.users.list;
    const pages = await this.fetchByIds("Base", "BaseGetUserVersions", "user_item", "BaseGetUsersById", "user_id");
    const list: User[] = pages.flatMap((p: any) =>
      asArray<any>(p.user).map((u) => ({
        id: String(u.key ?? u.id),
        name: u.name,
        loginName: u.login_name || undefined,
        email: u.email || undefined,
        primaryOrganization: u.primary_organization || undefined,
        organizations: asArray<any>(u.organization).map((o) => String(o.id)),
      })),
    );
    list.sort((a, b) => Number(a.id) - Number(b.id));
    this.users = { at: Date.now(), list };
    return list;
  }

  async listOrganizations(): Promise<Organization[]> {
    if (this.orgs && Date.now() - this.orgs.at < TTL_MS) return this.orgs.list;
    const pages = await this.fetchByIds(
      "Base",
      "BaseGetOrganizationVersions",
      "organization_item",
      "BaseGetOrganizationsById",
      "organization_id",
    );
    const list: Organization[] = pages.flatMap((p: any) =>
      asArray<any>(p.organization).map((o) => ({
        id: String(o.key ?? o.id),
        name: o.name,
        memberIds: asArray<any>(o.members?.user).map((u) => String(u.id)),
      })),
    );
    this.orgs = { at: Date.now(), list };
    return list;
  }

  async listFacilities(): Promise<Facility[]> {
    if (this.facilities && Date.now() - this.facilities.at < TTL_MS) return this.facilities.list;
    const pages = await this.fetchByIds(
      "Schedule",
      "ScheduleGetFacilityVersions",
      "facility_item",
      "ScheduleGetFacilitiesById",
      "facility_id",
    );
    const list: Facility[] = pages.flatMap((p: any) =>
      asArray<any>(p.facility).map((f) => ({
        id: String(f.key ?? f.id),
        name: f.name,
        description: f.description || undefined,
      })),
    );
    this.facilities = { at: Date.now(), list };
    return list;
  }

  async searchUsers(query: string): Promise<User[]> {
    const q = normalize(query);
    const [users, orgs] = await Promise.all([this.listUsers(), this.listOrganizations()]);
    if (!q) return users;
    const orgHits = new Set(orgs.filter((o) => normalize(o.name).includes(q)).flatMap((o) => o.memberIds));
    return users.filter(
      (u) =>
        u.id === query.trim() ||
        normalize(u.name).includes(q) ||
        (u.loginName && normalize(u.loginName).includes(q)) ||
        (u.email && normalize(u.email).includes(q)) ||
        orgHits.has(u.id),
    );
  }

  /** 名前・ID・メールから1人に決める。決まらなければ候補付きのエラー */
  async resolveUser(query: string): Promise<User> {
    const users = await this.listUsers();
    const t = query.trim();
    const exact = users.find((u) => u.id === t || u.loginName === t || u.email === t || u.name === t);
    if (exact) return exact;
    const q = normalize(t);
    const hits = users.filter(
      (u) => normalize(u.name).includes(q) || (u.loginName && normalize(u.loginName).includes(q)),
    );
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) throw new Error(`「${query}」に当たるユーザーが見つかりません。cybozu_search_users で確認してください。`);
    throw new Error(
      `「${query}」に当たるユーザーが${hits.length}人います。IDで指定してください: ` +
        hits
          .slice(0, 10)
          .map((u) => `${u.name}(id:${u.id})`)
          .join("、"),
    );
  }

  /** 設備を名前の一部またはIDから1つに決める */
  async resolveFacility(query: string): Promise<Facility> {
    const list = await this.listFacilities();
    const t = query.trim();
    const exact = list.find((f) => f.id === t || f.name === t);
    if (exact) return exact;
    const q = normalize(t);
    const hits = list.filter((f) => normalize(f.name).includes(q));
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) throw new Error(`「${query}」に当たる設備が見つかりません。cybozu_list_facilities で確認してください。`);
    throw new Error(
      `「${query}」に当たる設備が${hits.length}件あります。IDで指定してください: ` +
        hits.map((f) => `${f.name}(id:${f.id})`).join("、"),
    );
  }

  private planMenuCache?: { at: number; list: string[] };
  /** 予定メニュー（社内Ｍ、訪問 など）。システム設定 + 個人設定 */
  async planMenu(): Promise<string[]> {
    if (this.planMenuCache && Date.now() - this.planMenuCache.at < TTL_MS) return this.planMenuCache.list;
    const r = await this.soap.call("Schedule", "ScheduleGetProfiles", 'include_system_profile="true"');
    const split = (s?: string) => (s ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const list = [...new Set([...split(r.system_profile?.plan_menu), ...split(r.personal_profile?.plan_menu)])];
    this.planMenuCache = { at: Date.now(), list };
    return list;
  }

  async userName(id: string): Promise<string> {
    return (await this.listUsers()).find((u) => u.id === id)?.name ?? `id:${id}`;
  }

  async orgName(id: string): Promise<string | undefined> {
    return (await this.listOrganizations()).find((o) => o.id === id)?.name;
  }
}
