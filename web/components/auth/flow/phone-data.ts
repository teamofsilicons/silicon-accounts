/**
 * Every country calling code (ITU-T E.164), and a timezone → country table for guessing where a visitor is.
 *
 * The phone picker (components/arc/phone-input) formats the 49 countries it lists and knows no others. The hosted pages must take a
 * phone number from anywhere, so this table backs the "type it with its country code" mode of PhoneField: it tells
 * whether the digits after "+" start with a real calling code, and names the country. Only the server validates a
 * number for real (crates/core normalize_phone, full libphonenumber metadata).
 *
 * Calling codes are prefix-free by design (no code is the start of another), so the first match while reading 1, 2
 * then 3 digits is the code. Shared codes list their main country first (+1 United States, +7 Russia, +44 United
 * Kingdom…).
 */

export interface CallingCountry {
  /** ISO 3166-1 alpha-2. */
  iso: string;
  name: string;
  /** Calling code without the plus. */
  dial: string;
}

const RAW =
  "US:1:United States|CA:1:Canada|AG:1:Antigua and Barbuda|AI:1:Anguilla|AS:1:American Samoa|BB:1:Barbados|BM:1:Bermuda|BS:1:Bahamas|" +
  "DM:1:Dominica|DO:1:Dominican Republic|GD:1:Grenada|GU:1:Guam|JM:1:Jamaica|KN:1:Saint Kitts and Nevis|KY:1:Cayman Islands|" +
  "LC:1:Saint Lucia|MP:1:Northern Mariana Islands|MS:1:Montserrat|PR:1:Puerto Rico|SX:1:Sint Maarten|TC:1:Turks and Caicos Islands|" +
  "TT:1:Trinidad and Tobago|VC:1:Saint Vincent and the Grenadines|VG:1:British Virgin Islands|VI:1:U.S. Virgin Islands|" +
  "RU:7:Russia|KZ:7:Kazakhstan|EG:20:Egypt|ZA:27:South Africa|GR:30:Greece|NL:31:Netherlands|BE:32:Belgium|FR:33:France|ES:34:Spain|" +
  "HU:36:Hungary|IT:39:Italy|VA:39:Vatican City|RO:40:Romania|CH:41:Switzerland|AT:43:Austria|GB:44:United Kingdom|GG:44:Guernsey|" +
  "IM:44:Isle of Man|JE:44:Jersey|DK:45:Denmark|SE:46:Sweden|NO:47:Norway|SJ:47:Svalbard and Jan Mayen|PL:48:Poland|DE:49:Germany|" +
  "PE:51:Peru|MX:52:Mexico|CU:53:Cuba|AR:54:Argentina|BR:55:Brazil|CL:56:Chile|CO:57:Colombia|VE:58:Venezuela|MY:60:Malaysia|" +
  "AU:61:Australia|CX:61:Christmas Island|CC:61:Cocos (Keeling) Islands|ID:62:Indonesia|PH:63:Philippines|NZ:64:New Zealand|" +
  "SG:65:Singapore|TH:66:Thailand|JP:81:Japan|KR:82:South Korea|VN:84:Vietnam|CN:86:China|TR:90:Turkey|IN:91:India|PK:92:Pakistan|" +
  "AF:93:Afghanistan|LK:94:Sri Lanka|MM:95:Myanmar|IR:98:Iran|SS:211:South Sudan|MA:212:Morocco|EH:212:Western Sahara|DZ:213:Algeria|" +
  "TN:216:Tunisia|LY:218:Libya|GM:220:Gambia|SN:221:Senegal|MR:222:Mauritania|ML:223:Mali|GN:224:Guinea|CI:225:Côte d'Ivoire|" +
  "BF:226:Burkina Faso|NE:227:Niger|TG:228:Togo|BJ:229:Benin|MU:230:Mauritius|LR:231:Liberia|SL:232:Sierra Leone|GH:233:Ghana|" +
  "NG:234:Nigeria|TD:235:Chad|CF:236:Central African Republic|CM:237:Cameroon|CV:238:Cape Verde|ST:239:São Tomé and Príncipe|" +
  "GQ:240:Equatorial Guinea|GA:241:Gabon|CG:242:Congo|CD:243:Congo (DRC)|AO:244:Angola|GW:245:Guinea-Bissau|" +
  "IO:246:British Indian Ocean Territory|AC:247:Ascension Island|SC:248:Seychelles|SD:249:Sudan|RW:250:Rwanda|ET:251:Ethiopia|" +
  "SO:252:Somalia|DJ:253:Djibouti|KE:254:Kenya|TZ:255:Tanzania|UG:256:Uganda|BI:257:Burundi|MZ:258:Mozambique|ZM:260:Zambia|" +
  "MG:261:Madagascar|RE:262:Réunion|YT:262:Mayotte|ZW:263:Zimbabwe|NA:264:Namibia|MW:265:Malawi|LS:266:Lesotho|BW:267:Botswana|" +
  "SZ:268:Eswatini|KM:269:Comoros|SH:290:Saint Helena|TA:290:Tristan da Cunha|ER:291:Eritrea|AW:297:Aruba|FO:298:Faroe Islands|" +
  "GL:299:Greenland|GI:350:Gibraltar|PT:351:Portugal|LU:352:Luxembourg|IE:353:Ireland|IS:354:Iceland|AL:355:Albania|MT:356:Malta|" +
  "CY:357:Cyprus|FI:358:Finland|AX:358:Åland Islands|BG:359:Bulgaria|LT:370:Lithuania|LV:371:Latvia|EE:372:Estonia|MD:373:Moldova|" +
  "AM:374:Armenia|BY:375:Belarus|AD:376:Andorra|MC:377:Monaco|SM:378:San Marino|UA:380:Ukraine|RS:381:Serbia|ME:382:Montenegro|" +
  "XK:383:Kosovo|HR:385:Croatia|SI:386:Slovenia|BA:387:Bosnia and Herzegovina|MK:389:North Macedonia|CZ:420:Czechia|SK:421:Slovakia|" +
  "LI:423:Liechtenstein|FK:500:Falkland Islands|BZ:501:Belize|GT:502:Guatemala|SV:503:El Salvador|HN:504:Honduras|NI:505:Nicaragua|" +
  "CR:506:Costa Rica|PA:507:Panama|PM:508:Saint Pierre and Miquelon|HT:509:Haiti|GP:590:Guadeloupe|BL:590:Saint Barthélemy|" +
  "MF:590:Saint Martin|BO:591:Bolivia|GY:592:Guyana|EC:593:Ecuador|GF:594:French Guiana|PY:595:Paraguay|MQ:596:Martinique|" +
  "SR:597:Suriname|UY:598:Uruguay|CW:599:Curaçao|BQ:599:Caribbean Netherlands|TL:670:Timor-Leste|NF:672:Norfolk Island|" +
  "BN:673:Brunei|NR:674:Nauru|PG:675:Papua New Guinea|TO:676:Tonga|SB:677:Solomon Islands|VU:678:Vanuatu|FJ:679:Fiji|PW:680:Palau|" +
  "WF:681:Wallis and Futuna|CK:682:Cook Islands|NU:683:Niue|WS:685:Samoa|KI:686:Kiribati|NC:687:New Caledonia|TV:688:Tuvalu|" +
  "PF:689:French Polynesia|TK:690:Tokelau|FM:691:Micronesia|MH:692:Marshall Islands|KP:850:North Korea|HK:852:Hong Kong|MO:853:Macau|" +
  "KH:855:Cambodia|LA:856:Laos|BD:880:Bangladesh|TW:886:Taiwan|MV:960:Maldives|LB:961:Lebanon|JO:962:Jordan|SY:963:Syria|IQ:964:Iraq|" +
  "KW:965:Kuwait|SA:966:Saudi Arabia|YE:967:Yemen|OM:968:Oman|PS:970:Palestine|AE:971:United Arab Emirates|IL:972:Israel|" +
  "BH:973:Bahrain|QA:974:Qatar|BT:975:Bhutan|MN:976:Mongolia|NP:977:Nepal|TJ:992:Tajikistan|TM:993:Turkmenistan|AZ:994:Azerbaijan|" +
  "GE:995:Georgia|KG:996:Kyrgyzstan|UZ:998:Uzbekistan";

export const CALLING_COUNTRIES: readonly CallingCountry[] = RAW.split("|").map(entry => {
  const [iso = "", dial = "", name = ""] = entry.split(":");
  return { iso, dial, name };
});

const BY_ISO = new Map(CALLING_COUNTRIES.map(entry => [entry.iso, entry]));
/** Calling code → its countries, main one first. */
const BY_DIAL = new Map<string, CallingCountry[]>();
for (const entry of CALLING_COUNTRIES) BY_DIAL.set(entry.dial, [...(BY_DIAL.get(entry.dial) ?? []), entry]);

export const callingCountry = (iso: string | null | undefined): CallingCountry | null => (iso ? BY_ISO.get(iso.toUpperCase()) ?? null : null);

/** The calling code an international number's digits start with (`"40755…"` → `"40"`), or null. */
export function callingCodeOf(digits: string): string | null {
  for (const size of [1, 2, 3]) {
    const dial = digits.slice(0, size);
    if (dial.length === size && BY_DIAL.has(dial)) return dial;
  }
  return null;
}

/** True while `digits` could still become a calling code (`"42"` before `"423"`). */
export const isCallingCodePrefix = (digits: string): boolean => !!digits && CALLING_COUNTRIES.some(entry => entry.dial.startsWith(digits));

/** "Romania", "Russia or Kazakhstan", "the United States, Canada or a Caribbean country". */
export function countriesOf(dial: string): string | null {
  const countries = BY_DIAL.get(dial);
  if (!countries?.length) return null;
  if (dial === "1") return "the United States, Canada or the Caribbean";
  const names = countries.slice(0, 2).map(entry => entry.name);
  return countries.length > 2 ? `${names.join(", ")} and nearby` : names.join(" or ");
}

/** The longest an E.164 number can be (country code included), and a sensible floor for a whole number. */
export const E164_MAX_DIGITS = 15;
export const E164_MIN_DIGITS = 7;

/**
 * Timezones → the country they belong to (zone.tab), for guessing where a visitor is. A timezone says more than the
 * browser's language: many people browse in en-US wherever they live.
 */
const ZONES =
  "Europe/Amsterdam:NL|Europe/Andorra:AD|Europe/Astrakhan:RU|Europe/Athens:GR|Europe/Belgrade:RS|Europe/Berlin:DE|Europe/Bratislava:SK|" +
  "Europe/Brussels:BE|Europe/Bucharest:RO|Europe/Budapest:HU|Europe/Busingen:DE|Europe/Chisinau:MD|Europe/Copenhagen:DK|Europe/Dublin:IE|" +
  "Europe/Gibraltar:GI|Europe/Guernsey:GG|Europe/Helsinki:FI|Europe/Isle_of_Man:IM|Europe/Istanbul:TR|Europe/Jersey:JE|" +
  "Europe/Kaliningrad:RU|Europe/Kiev:UA|Europe/Kyiv:UA|Europe/Kirov:RU|Europe/Lisbon:PT|Europe/Ljubljana:SI|Europe/London:GB|" +
  "Europe/Luxembourg:LU|Europe/Madrid:ES|Europe/Malta:MT|Europe/Mariehamn:AX|Europe/Minsk:BY|Europe/Monaco:MC|Europe/Moscow:RU|" +
  "Europe/Oslo:NO|Europe/Paris:FR|Europe/Podgorica:ME|Europe/Prague:CZ|Europe/Riga:LV|Europe/Rome:IT|Europe/Samara:RU|" +
  "Europe/San_Marino:SM|Europe/Sarajevo:BA|Europe/Saratov:RU|Europe/Simferopol:UA|Europe/Skopje:MK|Europe/Sofia:BG|" +
  "Europe/Stockholm:SE|Europe/Tallinn:EE|Europe/Tirane:AL|Europe/Ulyanovsk:RU|Europe/Vaduz:LI|Europe/Vatican:VA|Europe/Vienna:AT|" +
  "Europe/Vilnius:LT|Europe/Volgograd:RU|Europe/Warsaw:PL|Europe/Zagreb:HR|Europe/Zurich:CH|Atlantic/Reykjavik:IS|Atlantic/Faroe:FO|" +
  "Atlantic/Canary:ES|Atlantic/Madeira:PT|Atlantic/Azores:PT|Atlantic/Bermuda:BM|Atlantic/Cape_Verde:CV|Atlantic/St_Helena:SH|" +
  "Atlantic/Stanley:FK|Asia/Almaty:KZ|Asia/Amman:JO|Asia/Anadyr:RU|Asia/Aqtau:KZ|Asia/Aqtobe:KZ|Asia/Ashgabat:TM|Asia/Atyrau:KZ|" +
  "Asia/Baghdad:IQ|Asia/Bahrain:BH|Asia/Baku:AZ|Asia/Bangkok:TH|Asia/Barnaul:RU|Asia/Beirut:LB|Asia/Bishkek:KG|Asia/Brunei:BN|" +
  "Asia/Calcutta:IN|Asia/Kolkata:IN|Asia/Chita:RU|Asia/Colombo:LK|Asia/Damascus:SY|Asia/Dhaka:BD|Asia/Dili:TL|Asia/Dubai:AE|" +
  "Asia/Dushanbe:TJ|Asia/Famagusta:CY|Asia/Gaza:PS|Asia/Hebron:PS|Asia/Ho_Chi_Minh:VN|Asia/Saigon:VN|Asia/Hong_Kong:HK|Asia/Hovd:MN|" +
  "Asia/Irkutsk:RU|Asia/Jakarta:ID|Asia/Jayapura:ID|Asia/Jerusalem:IL|Asia/Tel_Aviv:IL|Asia/Kabul:AF|Asia/Kamchatka:RU|" +
  "Asia/Karachi:PK|Asia/Kathmandu:NP|Asia/Katmandu:NP|Asia/Khandyga:RU|Asia/Krasnoyarsk:RU|Asia/Kuala_Lumpur:MY|Asia/Kuching:MY|" +
  "Asia/Kuwait:KW|Asia/Macau:MO|Asia/Magadan:RU|Asia/Makassar:ID|Asia/Manila:PH|Asia/Muscat:OM|Asia/Nicosia:CY|Asia/Novokuznetsk:RU|" +
  "Asia/Novosibirsk:RU|Asia/Omsk:RU|Asia/Oral:KZ|Asia/Phnom_Penh:KH|Asia/Pontianak:ID|Asia/Pyongyang:KP|Asia/Qatar:QA|" +
  "Asia/Qostanay:KZ|Asia/Qyzylorda:KZ|Asia/Rangoon:MM|Asia/Yangon:MM|Asia/Riyadh:SA|Asia/Sakhalin:RU|Asia/Samarkand:UZ|Asia/Seoul:KR|" +
  "Asia/Shanghai:CN|Asia/Singapore:SG|Asia/Srednekolymsk:RU|Asia/Taipei:TW|Asia/Tashkent:UZ|Asia/Tbilisi:GE|Asia/Tehran:IR|" +
  "Asia/Thimphu:BT|Asia/Tokyo:JP|Asia/Tomsk:RU|Asia/Ulaanbaatar:MN|Asia/Urumqi:CN|Asia/Ust-Nera:RU|Asia/Vientiane:LA|" +
  "Asia/Vladivostok:RU|Asia/Yakutsk:RU|Asia/Yekaterinburg:RU|Asia/Yerevan:AM|Asia/Aden:YE|" +
  "Africa/Abidjan:CI|Africa/Accra:GH|Africa/Addis_Ababa:ET|Africa/Algiers:DZ|Africa/Asmara:ER|Africa/Bamako:ML|Africa/Bangui:CF|" +
  "Africa/Banjul:GM|Africa/Bissau:GW|Africa/Blantyre:MW|Africa/Brazzaville:CG|Africa/Bujumbura:BI|Africa/Cairo:EG|Africa/Casablanca:MA|" +
  "Africa/Ceuta:ES|Africa/Conakry:GN|Africa/Dakar:SN|Africa/Dar_es_Salaam:TZ|Africa/Djibouti:DJ|Africa/Douala:CM|Africa/El_Aaiun:EH|" +
  "Africa/Freetown:SL|Africa/Gaborone:BW|Africa/Harare:ZW|Africa/Johannesburg:ZA|Africa/Juba:SS|Africa/Kampala:UG|Africa/Khartoum:SD|" +
  "Africa/Kigali:RW|Africa/Kinshasa:CD|Africa/Lagos:NG|Africa/Libreville:GA|Africa/Lome:TG|Africa/Luanda:AO|Africa/Lubumbashi:CD|" +
  "Africa/Lusaka:ZM|Africa/Malabo:GQ|Africa/Maputo:MZ|Africa/Maseru:LS|Africa/Mbabane:SZ|Africa/Mogadishu:SO|Africa/Monrovia:LR|" +
  "Africa/Nairobi:KE|Africa/Ndjamena:TD|Africa/Niamey:NE|Africa/Nouakchott:MR|Africa/Ouagadougou:BF|Africa/Porto-Novo:BJ|" +
  "Africa/Sao_Tome:ST|Africa/Tripoli:LY|Africa/Tunis:TN|Africa/Windhoek:NA|" +
  "America/Adak:US|America/Anchorage:US|America/Boise:US|America/Chicago:US|America/Denver:US|America/Detroit:US|" +
  "America/Indiana/Indianapolis:US|America/Indianapolis:US|America/Juneau:US|America/Kentucky/Louisville:US|America/Los_Angeles:US|" +
  "America/Louisville:US|America/Menominee:US|America/New_York:US|America/Nome:US|America/Phoenix:US|America/Sitka:US|" +
  "America/Yakutat:US|Pacific/Honolulu:US|America/Puerto_Rico:PR|America/Toronto:CA|America/Vancouver:CA|America/Edmonton:CA|" +
  "America/Winnipeg:CA|America/Halifax:CA|America/St_Johns:CA|America/Regina:CA|America/Moncton:CA|America/Montreal:CA|" +
  "America/Whitehorse:CA|America/Yellowknife:CA|America/Iqaluit:CA|America/Glace_Bay:CA|America/Goose_Bay:CA|" +
  "America/Mexico_City:MX|America/Cancun:MX|America/Chihuahua:MX|America/Hermosillo:MX|America/Mazatlan:MX|America/Merida:MX|" +
  "America/Monterrey:MX|America/Tijuana:MX|America/Matamoros:MX|America/Ojinaga:MX|America/Bahia_Banderas:MX|America/Ciudad_Juarez:MX|" +
  "America/Guatemala:GT|America/Belize:BZ|America/El_Salvador:SV|America/Tegucigalpa:HN|America/Managua:NI|America/Costa_Rica:CR|" +
  "America/Panama:PA|America/Havana:CU|America/Jamaica:JM|America/Port-au-Prince:HT|America/Santo_Domingo:DO|America/Nassau:BS|" +
  "America/Barbados:BB|America/Port_of_Spain:TT|America/Curacao:CW|America/Aruba:AW|America/Martinique:MQ|America/Guadeloupe:GP|" +
  "America/Cayman:KY|America/Grand_Turk:TC|America/St_Lucia:LC|America/St_Vincent:VC|America/Grenada:GD|America/Antigua:AG|" +
  "America/Dominica:DM|America/St_Kitts:KN|America/Anguilla:AI|America/Montserrat:MS|America/Tortola:VG|America/St_Thomas:VI|" +
  "America/Lower_Princes:SX|America/Marigot:MF|America/St_Barthelemy:BL|America/Kralendijk:BQ|America/Bogota:CO|America/Caracas:VE|" +
  "America/Guyana:GY|America/Paramaribo:SR|America/Cayenne:GF|America/Lima:PE|America/Guayaquil:EC|Pacific/Galapagos:EC|" +
  "America/La_Paz:BO|America/Santiago:CL|America/Punta_Arenas:CL|Pacific/Easter:CL|America/Asuncion:PY|America/Montevideo:UY|" +
  "America/Argentina/Buenos_Aires:AR|America/Buenos_Aires:AR|America/Argentina/Cordoba:AR|America/Cordoba:AR|" +
  "America/Argentina/Mendoza:AR|America/Argentina/Salta:AR|America/Argentina/Jujuy:AR|America/Argentina/Tucuman:AR|" +
  "America/Argentina/Catamarca:AR|America/Argentina/La_Rioja:AR|America/Argentina/San_Juan:AR|America/Argentina/San_Luis:AR|" +
  "America/Argentina/Rio_Gallegos:AR|America/Argentina/Ushuaia:AR|America/Sao_Paulo:BR|America/Manaus:BR|America/Bahia:BR|" +
  "America/Fortaleza:BR|America/Recife:BR|America/Belem:BR|America/Cuiaba:BR|America/Campo_Grande:BR|America/Porto_Velho:BR|" +
  "America/Boa_Vista:BR|America/Rio_Branco:BR|America/Maceio:BR|America/Araguaina:BR|America/Santarem:BR|America/Noronha:BR|" +
  "America/Eirunepe:BR|America/Nuuk:GL|America/Godthab:GL|America/Miquelon:PM|" +
  "Australia/Sydney:AU|Australia/Melbourne:AU|Australia/Brisbane:AU|Australia/Perth:AU|Australia/Adelaide:AU|Australia/Hobart:AU|" +
  "Australia/Darwin:AU|Australia/Canberra:AU|Australia/Lord_Howe:AU|Australia/Broken_Hill:AU|Australia/Lindeman:AU|Australia/Eucla:AU|" +
  "Pacific/Auckland:NZ|Pacific/Chatham:NZ|Pacific/Fiji:FJ|Pacific/Port_Moresby:PG|Pacific/Bougainville:PG|Pacific/Guam:GU|" +
  "Pacific/Saipan:MP|Pacific/Noumea:NC|Pacific/Tahiti:PF|Pacific/Apia:WS|Pacific/Tongatapu:TO|Pacific/Efate:VU|Pacific/Guadalcanal:SB|" +
  "Pacific/Tarawa:KI|Pacific/Kiritimati:KI|Pacific/Majuro:MH|Pacific/Palau:PW|Pacific/Pohnpei:FM|Pacific/Chuuk:FM|Pacific/Kosrae:FM|" +
  "Pacific/Nauru:NR|Pacific/Funafuti:TV|Pacific/Rarotonga:CK|Pacific/Niue:NU|Pacific/Norfolk:NF|Pacific/Pago_Pago:AS|" +
  "Pacific/Wallis:WF|Pacific/Fakaofo:TK|Indian/Maldives:MV|Indian/Mauritius:MU|Indian/Reunion:RE|Indian/Mahe:SC|" +
  "Indian/Antananarivo:MG|Indian/Comoro:KM|Indian/Mayotte:YT|Indian/Chagos:IO|Indian/Christmas:CX|Indian/Cocos:CC";

export const ZONE_COUNTRY: ReadonlyMap<string, string> = new Map(
  ZONES.split("|").map(entry => {
    const index = entry.lastIndexOf(":");
    return [entry.slice(0, index), entry.slice(index + 1)] as const;
  }),
);
