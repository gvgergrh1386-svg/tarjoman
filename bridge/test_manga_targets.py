"""Contract tests for the optional target adapter; no model, key or network."""
import unittest
from types import SimpleNamespace
from manga_target_runner import parse_answer, translator_method


class MangaTargets(unittest.TestCase):
    def test_strict_identity(self):
        self.assertEqual(parse_answer('{"translations":[{"id":1,"text":"bonjour"},{"id":3,"text":"bad"},{"id":true,"text":"bad"}]}', 2), {1:'bonjour'})
        self.assertEqual(parse_answer('[{"id":1,"text":"one"},{"id":1,"text":"two"}]', 1), {})

    def test_bad_and_fenced_json(self):
        for raw in ('text', '{}', 'null', '"text"', '{"translations":{}}'):
            self.assertEqual(parse_answer(raw, 2), {})
        self.assertEqual(parse_answer('```json\n[{"id":1,"text":"日本語"}]\n```',1), {1:'日本語'})

    def test_repair_preserves_first_answers_and_untranslated_source(self):
        answers=iter(['[{"id":1,"text":"Bonjour"}]','[{"id":1,"text":"wrong"},{"id":2,"text":"世界"}]'])
        requests=[]
        def chat(messages, **opts):
            requests.append((messages,opts));return next(answers)
        client=SimpleNamespace(_chat=chat, endpoint_status=lambda:(True,'fixture'))
        blocks=[SimpleNamespace(text=t,translation='',kind='bubble') for t in ['hello','world','retained source']]
        result=translator_method('fr',lambda **kw:SimpleNamespace(**kw))(client,blocks)
        self.assertEqual([b.translation for b in blocks],['Bonjour','世界',''])
        self.assertEqual(blocks[2].text,'retained source');self.assertEqual(result.missing,1)
        self.assertIn('fr',requests[0][0][0]['content']);self.assertGreaterEqual(requests[0][1]['min_out_tokens'],96+48*3)

    def test_font_failure_never_assigns_unrenderable_translation(self):
        client=SimpleNamespace(_chat=lambda *a,**k:'[{"id":1,"text":"日本語"}]',endpoint_status=lambda:(False,'fixture'))
        block=SimpleNamespace(text='source',translation='')
        def missing(text):raise RuntimeError('missing glyph')
        with self.assertRaisesRegex(RuntimeError,'missing glyph'):
            translator_method('ja',lambda **kw:SimpleNamespace(**kw),missing)(client,[block])
        self.assertEqual(block.translation,'');self.assertEqual(block.text,'source')

    def test_complete_batch_and_empty_batch(self):
        client=SimpleNamespace(_chat=lambda *a,**k:'[{"id":1,"text":"مرحبا"}]',endpoint_status=lambda:(False,'fixture'))
        method=translator_method('ar',lambda **kw:SimpleNamespace(**kw))
        self.assertTrue(method(client,[]).ok)
        result=method(client,[SimpleNamespace(text='Hello',translation='')])
        self.assertTrue(result.ok);self.assertFalse(result.is_local);self.assertEqual(result.provider_label,'fixture')


if __name__=='__main__':
    unittest.main(verbosity=2)
