/**
 * Vocabulary for the entity detector.
 *
 * Kept apart from the detector itself so the word lists can be read, argued
 * with, and extended without wading through matching logic.
 */

/**
 * Capitalised words that are almost never a person's name in running text.
 * This list is the main thing standing between a name detector and a flood of
 * false positives, because English capitalises far more than names.
 */
export const NOT_A_NAME = new Set(
  (
    "january february march april may june july august september october november december " +
    "monday tuesday wednesday thursday friday saturday sunday " +
    "jan feb mar apr jun jul aug sep sept oct nov dec mon tue wed thu fri sat sun " +
    "the this that these those there their they them then than " +
    "and or but for nor yet so if because while when where which who whom whose what how why " +
    "a an of in on at to from by with without into onto upon over under above below " +
    "is are was were be been being have has had do does did will would shall should may might must can could " +
    "invoice receipt order total subtotal amount price cost payment paid due balance " +
    "date time today tomorrow yesterday now " +
    "name address email phone mobile contact details information " +
    "home about help support login logout signin signup register account settings profile dashboard " +
    "search menu close open next previous back continue submit cancel save delete edit view download upload " +
    "yes no ok okay all none any some more less new old " +
    "terms privacy policy cookie cookies legal copyright rights reserved " +
    "company customer client user admin administrator guest member " +
    "india indian bharat delhi mumbai bangalore bengaluru chennai kolkata hyderabad pune " +
    "ahmedabad jaipur lucknow surat kanpur nagpur indore bhopal patna vadodara " +
    "north south east west central " +
    "monday state district city town village country " +
    "product products service services page site website app application " +
    "welcome thank thanks please note important warning error success failed " +
    "click here read learn get started free premium pro basic standard " +
    "google facebook twitter amazon microsoft apple android chrome windows linux " +
    "english hindi language version update news blog article post comment share " +
    "shipping billing delivery return refund cart checkout " +
    "quantity item items description reference number status active inactive pending " +
    "gst tax cgst sgst igst hsn sac " +
    "dear sir madam your our my you we us it its sales marketing team hr department"
  ).split(/\s+/),
);

/**
 * Words a name can never begin with, even when the evidence around it is
 * strong. This is the small subset of the list above that is safe to apply to
 * a name introduced by a cue or an honorific: "Bill to: The Customer" is not a
 * name because it starts with "The"; "Bill to: Bharat Kumar" is one even though
 * "Bharat" is also the country, because a cue was in front of it.
 */
export const NEVER_STARTS_A_NAME = new Set(
  (
    "the a an this that these those and or but for to of in on at from by with " +
    "your our my their his her its you we us they it " +
    "dear regards thanks please"
  ).split(/\s+/),
);

/**
 * Words that must never be swapped for a token in text the *user* wrote.
 *
 * Aligning the request with the page is a literal find-and-replace of vault
 * values, and a vault holds whatever the page called a person. Gmail lists a
 * thread's participants as "me, you", so "you" was learnt as a name - and then
 * "tell me the oldest sender you can see" was sent to the model as "the oldest
 * sender <NAME_21> can see". The instruction was destroyed by its own privacy
 * layer, which is far worse than leaving a three-letter word alone.
 *
 * A pronoun or a function word is never what the user meant to name, whatever
 * the page called it. Length alone cannot decide this: "Raj" is three letters
 * and is a name; "you" is three letters and never is.
 */
export const NEVER_ALIGN = new Set(
  (
    "i me my mine myself we us our ours you your yours he him his she her hers " +
    "it its they them their theirs this that these those who whom whose which what " +
    "a an the and or but if then than so as at by for from in into of on to up with " +
    "is are was were be been being am do does did done have has had will would can " +
    "could shall should may might must not no yes all any some none more most less " +
    "here there now then when where why how new old first last next previous " +
    "me too also both each every other another same such only just very " +
    "mail email inbox sender subject reply forward draft message page site link " +
    "one two three four five six seven eight nine ten"
  ).split(/\s+/),
);

/**
 * Honorifics as a set, for stripping them off the front of a name that a cue
 * phrase captured whole: "Dear Mr. Rahul Verma" is Rahul Verma, and the
 * honorific is not part of the identifier.
 */
export const HONORIFIC_WORDS = new Set(
  "mr mrs ms miss mx dr prof professor sir madam shri shree sri smt kum capt col maj lt rev hon".split(" "),
);

/** Titles that make the following capitalised words a name with near-certainty. */
export const HONORIFICS =
  "Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Professor|Sir|Madam|Shri|Shree|Sri|Smt|Smt\\.|Kum|Capt|Col|Maj|Lt|Rev|Hon";

/**
 * Suffixes that make a capitalised phrase an organisation. Indian legal forms
 * first, because that is the corpus this is built for.
 */
export const ORG_SUFFIXES =
  "Pvt\\.?\\s*Ltd\\.?|Private\\s+Limited|Public\\s+Limited|Limited|Ltd\\.?|LLP|LLC|L\\.L\\.C\\.|" +
  "Inc\\.?|Incorporated|Corp\\.?|Corporation|Company|Co\\.?|GmbH|S\\.A\\.|B\\.V\\.|N\\.V\\.|PLC|" +
  "Enterprises|Enterprise|Traders|Trading|Industries|Industry|Solutions|Technologies|Technology|" +
  "Systems|Services|Associates|Consultants|Consultancy|Ventures|Holdings|Group|Partners|" +
  "&\\s*Sons|and\\s+Sons|&\\s*Co\\.?|Foundation|Trust|Society|Institute|Academy|University|College|" +
  "School|Hospital|Clinic|Bank|Insurance|Motors|Textiles|Exports|Imports|Agencies|Stores|Mart";

/**
 * Phrases that introduce a person or an organisation. The cue does the work;
 * what follows only has to look like a proper noun.
 */
export const NAME_CUES =
  "Dear|Hi|Hello|Hey|Regards|Best\\s+regards|Kind\\s+regards|Sincerely|Yours\\s+truly|Yours\\s+sincerely|" +
  "Thanks|Thank\\s+you|Attn|Attention|Bill\\s+to|Billed\\s+to|Bill\\s+To|Invoice\\s+to|Invoice\\s+for|" +
  "Sold\\s+to|Ship\\s+to|Shipped\\s+to|Consignee|Consignor|Buyer|Seller|Vendor|Supplier|" +
  "Applicant|Candidate|Employee|Customer|Client|Patient|Student|Beneficiary|Nominee|Guardian|" +
  "Account\\s+holder|Account\\s+Name|Signed\\s+by|Submitted\\s+by|Prepared\\s+by|Approved\\s+by|" +
  "Requested\\s+by|Reported\\s+by|Assigned\\s+to|Posted\\s+by|Written\\s+by|Author|Owner|" +
  "Father'?s?\\s+Name|Mother'?s?\\s+Name|Spouse|Husband|Wife|Contact\\s+person|" +
  "Name\\s+of\\s+(?:the\\s+)?(?:applicant|candidate|employee|customer|holder|person|company|firm)";

/** Street-type words that anchor an Indian postal address line. */
export const STREET_TYPES =
  "Road|Rd|Street|St|Marg|Path|Lane|Ln|Cross|Main|Avenue|Ave|Boulevard|Highway|Bypass|" +
  "Nagar|Colony|Layout|Sector|Block|Phase|Extension|Extn|Enclave|Vihar|Puram|Pura|Ganj|Bagh|" +
  "Chowk|Circle|Square|Park|Garden|Gardens|Society|Apartments|Apartment|Towers|Tower|" +
  "Residency|Heights|Complex|Plaza|Arcade|Bhawan|Bhavan|Sadan|Niwas|Villa|House|Building|" +
  "Floor|Flat|Plot|Survey|Gali|Mohalla|Basti|Pally|Palli|Peth|Wadi|Chawl";

/** Indian states and union territories, used to confirm an address. */
export const STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat",
  "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh",
  "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab",
  "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh",
  "Uttarakhand", "West Bengal", "Andaman and Nicobar Islands", "Chandigarh",
  "Dadra and Nagar Haveli", "Daman and Diu", "Delhi", "New Delhi", "Jammu and Kashmir",
  "Ladakh", "Lakshadweep", "Puducherry", "Pondicherry",
];

/** Major cities, for the same purpose. Not exhaustive and does not need to be. */
export const CITIES = [
  "Mumbai", "Delhi", "New Delhi", "Bengaluru", "Bangalore", "Hyderabad", "Ahmedabad",
  "Chennai", "Kolkata", "Surat", "Pune", "Jaipur", "Lucknow", "Kanpur", "Nagpur",
  "Indore", "Thane", "Bhopal", "Visakhapatnam", "Patna", "Vadodara", "Ghaziabad",
  "Ludhiana", "Agra", "Nashik", "Faridabad", "Meerut", "Rajkot", "Varanasi", "Srinagar",
  "Aurangabad", "Dhanbad", "Amritsar", "Allahabad", "Prayagraj", "Ranchi", "Howrah",
  "Coimbatore", "Jabalpur", "Gwalior", "Vijayawada", "Jodhpur", "Madurai", "Raipur",
  "Kota", "Guwahati", "Mysuru", "Mysore", "Noida", "Gurugram", "Gurgaon", "Kochi",
  "Cochin", "Thiruvananthapuram", "Chandigarh", "Bhubaneswar", "Dehradun", "Shimla",
];

/**
 * Words that appear inside organisation names and should not, on their own,
 * disqualify a phrase for containing a lowercase word. "Bank of Baroda",
 * "Tata and Sons".
 *
 * "for" is deliberately absent: it connects a sentence to a company far more
 * often than it appears inside one, and including it lets "Invoice for Sharma
 * Traders" match as a single organisation.
 */
export const ORG_CONNECTORS = new Set(["and", "of", "the", "de", "van", "der", "bin", "al"]);
