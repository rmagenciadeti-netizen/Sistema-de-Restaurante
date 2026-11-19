// Fictitious MySQL dump of an unknown legacy restaurant system (never real data). Used by the unit and database tests.
export const LEGACY_FINANCE_DUMP = [
  'CREATE TABLE `tb_forn` (`cod_forn` int NOT NULL, `razao_social` varchar(80), `nome_fantasia` varchar(80), `cnpj` varchar(20), `ie` varchar(20), `fone` varchar(20), `email` varchar(60), `endereco` varchar(100), `cep` varchar(9), `cidade` varchar(40), `uf` varchar(20), `contato` varchar(40), `obs` varchar(100), PRIMARY KEY (`cod_forn`));',
  "INSERT INTO `tb_forn` VALUES (1,'Distribuidora Alfa Ltda','Alfa Bebidas','11.222.333/0001-81','123.456.789','(11) 3333-4444','VENDAS@ALFA.COM','Rua A, 100','1310100','São Paulo','sp','Carlos','Prazo 30 dias'),(2,'Hortifruti Beta ME','Beta','11.444.777/0001-61','','11 98888-1111','','','','Campinas','São Paulo','Marta','');",
  'CREATE TABLE `tb_cli` (`cod_cli` int NOT NULL, `nome_cliente` varchar(80), `cpf_cnpj` varchar(20), `celular` varchar(20), `whatsapp` varchar(20), `mail` varchar(60), `endereco` varchar(100), `cep` varchar(9), `cidade` varchar(40), `estado` varchar(20), PRIMARY KEY (`cod_cli`));',
  "INSERT INTO `tb_cli` VALUES (1,'Ana Souza','529.982.247-25','','(11) 91234-5678','ana@x.com','Rua B, 1','01310-100','São Paulo','SP'),(2,'Bruno Lima','','(11) 97777-6666','','','','','',''),(3,'Empresa Gama','11.222.333/0001-81','1155556666','','','','','','');",
  'CREATE TABLE `tb_centro_custo` (`cod_cc` int NOT NULL, `nome` varchar(40), PRIMARY KEY (`cod_cc`));',
  "INSERT INTO `tb_centro_custo` VALUES (1,'Cozinha'),(2,'Salão');",
  'CREATE TABLE `tb_conta_bancaria` (`cod_conta` int NOT NULL, `nome_conta` varchar(40), `banco` varchar(30), `agencia` varchar(10), `nr_conta` varchar(15), `saldo_inicial` varchar(20), `dt_saldo` varchar(12), PRIMARY KEY (`cod_conta`));',
  "INSERT INTO `tb_conta_bancaria` VALUES (1,'Caixa Itaú','Itaú','1234','56789-0','10.500,00','01/01/2024'),(2,'Poupança Reserva','Caixa','0001','1111-1','-250,50','2024-01-01');",
  'CREATE TABLE `tb_categoria_financeira` (`cod_cat` int NOT NULL, `nome` varchar(40), `tipo` varchar(10), `cod_pai` int, PRIMARY KEY (`cod_cat`));',
  "INSERT INTO `tb_categoria_financeira` VALUES (1,'Insumos','Despesa',NULL),(2,'Bebidas','Despesa',1),(3,'Vendas Salão','Receita',NULL),(4,'Aluguel','Despesa',NULL);",
  'CREATE TABLE `tb_contas_pagar` (`id_cp` int NOT NULL, `descricao` varchar(80), `cod_forn` int, `nr_doc` varchar(20), `parcela` varchar(10), `total_parcelas` int, `valor` varchar(20), `vl_pago` varchar(20), `juros` varchar(20), `desconto` varchar(20), `dt_emissao` varchar(12), `dt_venc` varchar(12), `dt_pgto` varchar(12), `cod_cat` int, `cod_cc` int, `cod_conta` int, `forma_pgto` varchar(20), `situacao` varchar(20), `obs` varchar(60), PRIMARY KEY (`id_cp`));',
  'INSERT INTO `tb_contas_pagar` VALUES ' + [
    "(1,'Compra bebidas NF 1001',1,'NF-1001','1',3,'1.000,00','1.000,00','0','0','10/01/2024','10/02/2024','09/02/2024',2,1,1,'Boleto','Pago','')",
    "(2,'Compra bebidas NF 1001',1,'NF-1001','2',3,'1.000,00','400,00','0','0','10/01/2024','10/03/2024','11/03/2024',2,1,1,'Boleto','Parcial','Pagamento parcial')",
    "(3,'Compra bebidas NF 1001',1,'NF-1001','3',3,'1.000,00','','','','10/01/2024','10/04/2024','',2,1,1,'Boleto','Aberto','')",
    "(4,'Aluguel janeiro',2,'','',NULL,'5.000,00','5.100,00','100,00','','05/01/2024','05/01/2024','05/01/2024',4,2,1,'PIX','Pago','')",
    "(5,'Pago sem data',1,'NF-1005','',NULL,'300,00','300,00','','','01/02/2024','01/03/2024','',2,1,1,'PIX','Pago','')",
    "(6,'Quitado sem valor',1,'NF-1006','',NULL,'250,00','','','','01/02/2024','01/03/2024','01/03/2024',2,1,1,'PIX','Quitado','')",
    "(7,'Compra cancelada',1,'NF-1007','',NULL,'80,00','','','','01/02/2024','01/03/2024','',2,1,NULL,'','Cancelado','')",
    "(8,'Aluguel janeiro',2,'','',NULL,'5.000,00','5.100,00','100,00','','05/01/2024','05/01/2024','05/01/2024',4,2,1,'PIX','Pago','')",
    "(9,'Fornecedor desconhecido',99,'NF-1009','',NULL,'90,00','','','','01/02/2024','01/03/2024','',2,1,1,'','Aberto','')",
    "(10,'Valor inválido',1,'NF-1010','',NULL,'abc','','','','01/02/2024','01/03/2024','',2,1,1,'','Aberto','')",
    "(11,'Data inválida',1,'NF-1011','',NULL,'70,00','','','','01/02/2024','31/02/2024','',2,1,1,'','Aberto','')",
  ].join(',') + ';',
  'CREATE TABLE `tb_contas_receber` (`id_cr` int NOT NULL, `descricao` varchar(80), `cod_cli` int, `nr_doc` varchar(20), `parcela` varchar(10), `total_parcelas` int, `valor` varchar(20), `vl_recebido` varchar(20), `dt_emissao` varchar(12), `dt_venc` varchar(12), `dt_recebimento` varchar(12), `cod_cat` int, `cod_conta` int, `forma_recebimento` varchar(20), `situacao` varchar(20), PRIMARY KEY (`id_cr`));',
  'INSERT INTO `tb_contas_receber` VALUES ' + [
    "(1,'Fiado Ana',1,'F-1','1/2',NULL,'50,00','50,00','01/02/2024','15/02/2024','16/02/2024',3,1,'Dinheiro','Recebido')",
    "(2,'Fiado Ana',1,'F-1','2/2',NULL,'50,00','0','01/02/2024','15/03/2024','',3,1,'','Aberto')",
    "(3,'Evento Gama',3,'','',NULL,'2.000,00','2.000,00','10/02/2024','20/02/2024','21/02/2024',3,1,'PIX','Recebido')",
  ].join(',') + ';',
  'CREATE TABLE `produtos` (`cod_prod` int NOT NULL, `nome` varchar(80), `preco_venda` varchar(20), `preco_custo` varchar(20), `cod_barras` varchar(14), `grupo` varchar(30), `subgrupo` varchar(30), `cod_forn` int, `un` varchar(5), `estoque` varchar(10), `est_min` varchar(10), `margem` varchar(10), PRIMARY KEY (`cod_prod`));',
  "INSERT INTO `produtos` VALUES (1,'Cerveja Lata 350ml','6,50','3,20','7891000100103','Bebidas','Cervejas',1,'UN','120','24','103'),(2,'Tomate kg','8,90','5,00','','Hortifruti','',2,'kg','15,5','5','');",
].join('\n');

// A CSV of payables that refer to the supplier by name (no relationship), used for the "large file" scenarios.
export function bigPayablesCsv(rows: number, supplier: string): string {
  const lines = ['descricao;fornecedor;documento;valor;vencimento;situacao'];
  for (let index = 1; index <= rows; index++) lines.push(`Despesa ${index};${supplier};DOC-${index};${(10 + (index % 90)).toString()},50;${String(1 + (index % 28)).padStart(2, '0')}/0${1 + (index % 9)}/2025;Aberto`);
  return lines.join('\n');
}
