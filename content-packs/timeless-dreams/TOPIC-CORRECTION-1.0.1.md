# Legends Across Every Civilisation 1.0.1 — editorial correction

Content-only successor to 1.0.0; the original source, pack/item/family/SKU identities and formula compatibility are preserved. Release floor 1.0.843. No new assets or dependencies.

Reservation revision 221; receipt `authoring:8e7d1cd69b78e9d0834c64118ca5c3dd45335f2931a4c75d9b67d03ffe2cc1bd`. Based on main `864781d9`. Sources below ground original editorial revisions, not copied prose. There remain 50 profiles and 1,000 assignments; structural diversity does not guarantee that generated episodes cannot repeat.

Independent review additionally corrected the Newburgh informant’s rank from canon to archdeacon and replaced two semantically duplicate narratives. The successor manifest is checked against its registry identity and entitlement.

# Legends Across Every Civilisation — factual correction map

The changes below are applied in `topic/legends-across-every-civilisation-v1.0.1/content/topic-pack.json`.

## Scope changes

| Tuple path | Replacement’s factual anchor | Source |
|---|---|---|
| `coverage_profiles[the sun and the journey it makes every day].tuples[6]` | Nut represents the sky, swallows the sun at night, and gives birth at dawn; the replacement removes the contradictory old “each morning” object. | [British Museum, Nut](https://www.britishmuseum.org/learn/schools/ages-7-11/ancient-egypt/ancient-egyptian-gods-and-goddesses) |
| `coverage_profiles[the sun and the journey it makes every day].tuples[11]` | The Hawaiian Māui account at Haleakalā has Hina unable to dry kapa until Māui snares and slows the sun. | [National Park Service, Māui snaring the sun](https://www.nps.gov/hale/learn/historyculture/deities.htm) |
| `coverage_profiles[the moon, and the marks that people read on it].tuples[5]` | A Tang-period Chinese mirror depicts Chang’e with a rabbit using pestle and mortar to grind elixir ingredients. | [Metropolitan Museum of Art, Mirror with moon goddess and rabbit](https://www.metmuseum.org/art/collection/search/61405) |
| `coverage_profiles[the rulers of the land of the dead].tuples[7]` | The Oxford ETCSL edition records the seven gates; at the seventh, Inana’s garment of ladyship is removed. The correction replaces the inaccurate gate-greeting object. | [University of Oxford ETCSL, Inana’s descent](https://etcsl.orinst.ox.ac.uk/edition2/etcslgloss.php?charencgcirc=&lookup=c141.160&sn=ON) |
| `coverage_profiles[the weighing and the judging of souls].tuples[2]` | Qāf 50:17–18 describes two recording angels, one at the right and one at the left. | [Qur’an 50:17–18](https://quran.com/50/17-18) |
| `coverage_profiles[the birds that are reborn out of fire].tuples[1]` | Herodotus reports the Heliopolitan phoenix story: it carries its father, enclosed in myrrh, to the temple of the Sun. The correction removes the unsupported ashes/rebirth wording. | [Herodotus, *Histories* 2.73](https://www.perseus.tufts.edu/hopper/text?doc=Perseus%3Atext%3A1999.01.0126%3Abook%3D2&force=y) |
| `coverage_profiles[the lion-bodied guardians at the gate].tuples[4]` | The Met’s Kamakura pair is placed before shrine entrances; one guardian has an open mouth and the other a closed mouth. | [Metropolitan Museum of Art, Guardian Lion-Dogs](https://www.metmuseum.org/art/collection/search/53190) |
| `coverage_profiles[the monsters who ask a question before they attack].tuples[1]` | The Oedipus story has the Sphinx’s four/two/three-legged riddle answered as a human life course. | [Global Egyptian Museum, Oedipus and the Sphinx](https://www.globalegyptianmuseum.org/record.aspx?id=15902&lan=S) |
| `coverage_profiles[the beings whose look can kill].tuples[1]` | Apollodorus has Perseus use a brazen shield’s reflection, avoiding Medusa’s gaze before beheading her; the correction removes the false claim that Medusa dies from viewing herself. | [Apollodorus, *Library* 2.4](https://www.perseus.tufts.edu/hopper/text?doc=Perseus%3Atext%3A1999.01.0022%3Atext%3DLibrary%3Abook%3D2%3Achapter%3D4) |
| `coverage_profiles[the smiths of the gods and the things they made].tuples[1]` | In *Odyssey* 8, Hephaestus forges bonds fine as spider webs to catch Ares and Aphrodite. | [Homer, *Odyssey* 8](https://www.perseus.tufts.edu/hopper/text?doc=Perseus%3Atext%3A1999.01.0136%3Abook%3D8) |

## Evidence-lens changes

| Tuple path | Why the full tuple changes | Source |
|---|---|---|
| `coverage_profiles[the people who take the shape of wolves].tuples[0]` | Ovid’s Lycaon story supplies a named literary tradition and a real textual record, rather than a vague collected account. The later Arcadian rite comparison should remain qualified as later evidence. | [Ovid, *Metamorphoses* 1.163ff.](https://scaife-reader.perseus.tufts.edu/reader/urn%3Acts%3AlatinLit%3Aphi0959.phi006.perseus-eng3%3A1.163.249/), [Pausanias on Lycaean transformation](https://www.perseus.tufts.edu/hopper/text?doc=Paus.+8&fromdoc=Perseus%3Atext%3A1999.01.0160) |
| `coverage_profiles[the wild men of the mountains and the forests].tuples[0]` | Enkidu is a specific Mesopotamian wild-man episode, preserved in cuneiform witnesses, not a generic high-pass sighting. | [French Ministry of Culture, first Gilgamesh tablet](https://archeologie.culture.gouv.fr/nimrud/fr/la-1ere-tablette-de-lepopee-de-gilgamesh) |
| `coverage_profiles[the dead who come home].tuples[2]` | Newburgh identifies the location, an archdeacon informant, the wife’s bedroom, the street watches, and the bishop’s written absolution; all revised fields stay inside that account. | [William of Newburgh, *Historia rerum anglicarum* 5.22](https://ruthjsalter.wordpress.com/wp-content/uploads/2017/10/william-of-newburgh-historia-rerum-anglicarum-5-xxii-xxiv1.pdf) |
| `coverage_profiles[the small underground people who work metal].tuples[11]` | Alberich is a named dwarf guardian of the Nibelung treasure; the cloud-cloak contest and treasure-keeping occur in the medieval German heroic poem. | [*Nibelungenlied*, Needler translation](https://www.gutenberg.org/files/7321/7321-h/7321-h.htm) |

The correction set replaces ten full tuples and four affected evidence-lens tuples. The affected wolf, wild-man, and underground-smith profiles were checked entry by entry: none already names Lycaon, Enkidu, or Alberich, so these are not duplicate variants in their own twenty-tuple profile. Applied non-mutatively, the present `a tradition where the` head count falls from 59 to 49 of 1,000 and `collected accounts compared with` falls from 53 to 49 of 1,000. Those counts are from the current exact four-word affix guard; the sources above are the reason to use these replacements, not a license to apply them mechanically.

# Legends Across Every Civilisation — duplicate-removal corrections

The changes below are applied in `topic/legends-across-every-civilisation-v1.0.1/content/topic-pack.json`.

| Tuple path | Distinct source-grounded replacement | Source |
|---|---|---|
| `coverage_profiles[the rulers of the land of the dead].tuples[1]` | The *Kojiki*’s Yomi episode has Izanagi visit the dead Izanami, break her command not to look, and flee; Izanami is named the great kami of Yomi. It is distinct from Inana’s seven-gate descent. | [Kokugakuin University Digital Museum, Izanami](https://d-museum.kokugakuin.ac.jp/eos/detail/?id=9384), [Kojiki translation, chapter 9](https://www1.udel.edu/History-old/flaherty/primary_sources/2%20Kojiki%2825%29.pdf) |
| `coverage_profiles[the monsters who ask a question before they attack].tuples[0]` | In the *Mahābhārata*’s Yaksha’s Questions, a lake guardian demands answers before water may be taken; the brothers who ignore it fall, while Yudhishthira’s answers permit restoration. This is distinct from both Theban Sphinx tuples and the Norse god–giant contest already present. | [Bibliothèque nationale de France, *Mahābhārata* Vana Parva/Yakṣapraśna record](https://catalogue.bnf.fr/ark%3A/12148/cb158661157), [Yaksha’s Questions text](https://sanskritdocuments.org/doc_z_misc_major_works/yaxa.html) |

The two affected profiles were searched for `Izanami`, `Yomi`, `yaksha`, and `Yudhishthira`; none appears in their existing twenty tuples. These changes are semantic de-duplication, not affix padding changes.
