import type { ListDoc } from '../../shared/schema';

const item = (id: string, label: string, parentId: string | null = null) => ({
  id,
  label,
  parentId,
});

/**
 * Lists seeded into every new bible (ARCH-8). They are generic on purpose:
 * values that belong to one novel, such as its communities, arrive through
 * import or editing, never from code (A16). Every list is editable (ED-8).
 */
export function defaultLists(): ListDoc[] {
  return [
    {
      _id: 'unionTypes',
      label: 'Union types',
      items: [item('married', 'Married'), item('partnered', 'Partnered'), item('other', 'Other')],
    },
    {
      _id: 'parentLinkTypes',
      label: 'Parent link types',
      items: [
        item('biological', 'Biological'),
        item('adoptive', 'Adoptive'),
        item('step', 'Step'),
        item('guardian', 'Guardian'),
      ],
    },
    { _id: 'communities', label: 'Communities', items: [] },
    {
      _id: 'statuses',
      label: 'Statuses',
      items: [item('canon', 'Canon'), item('planned', 'Planned'), item('idea', 'Idea')],
    },
    {
      _id: 'provenance',
      label: 'Provenance',
      items: [item('researched', 'Researched'), item('invented', 'Invented')],
    },
    {
      _id: 'eventCategories',
      label: 'Event categories',
      items: [
        item('geopolitics', 'Geopolitics'),
        item('technology', 'Technology'),
        item('economy', 'Economy'),
        item('environment', 'Environment'),
        item('demographics', 'Demographics'),
        item('culture', 'Culture'),
      ],
    },
    {
      _id: 'romanizationSystems',
      label: 'Romanization systems',
      items: [item('mandarin', 'Hanyu Pinyin'), item('cantonese', 'Jyutping')],
    },
    {
      _id: 'languages',
      label: 'Languages',
      items: [
        item('mandarin', 'Mandarin'),
        item('cantonese', 'Cantonese'),
        item('english', 'English'),
      ],
    },
    /**
     * A51 (SM-3): what kind of moment a moment is. The colours are the light
     * theme values of the `--kind-*` tokens; Voice has none and draws in `--fg-2`.
     */
    {
      _id: 'momentKinds',
      label: 'Moment kinds',
      items: [
        { ...item('move', 'Moves'), color: '#008300' },
        { ...item('life', 'Life event'), color: '#e34948' },
        { ...item('work', 'Work and study'), color: '#4a3aa7' },
        item('voice', 'Voice'),
      ],
    },
    /** Tags are added as entries use them, and renamed here (ED-8). */
    { _id: 'tags', label: 'Tags', items: [] },
  ];
}
