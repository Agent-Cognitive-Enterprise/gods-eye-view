<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<S124:Dataset xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:S124="http://www.iho.int/S124/gml/2.0" xmlns:S100="http://www.iho.int/s100gml/5.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xlink="http://www.w3.org/1999/xlink" gml:id="CCG.S124.CA01.C.3398.24" xsi:schemaLocation="http://www.iho.int/S124/gml/2.0 https://schemas.s100dev.net/schemas/S124/2.0.0/20250728/124_2.0.0.xsd">
    <gml:boundedBy>
        <gml:Envelope srsName="https://www.opengis.net/def/crs/EPSG/0/4326" srsDimension="2">
            <gml:lowerCorner>46.396317 -72.386917</gml:lowerCorner>
            <gml:upperCorner>46.412983 -72.370250</gml:upperCorner>
        </gml:Envelope>
    </gml:boundedBy>
    <S100:DatasetIdentificationInformation>
        <S100:encodingSpecification>S-100 Part 10b</S100:encodingSpecification>
        <S100:encodingSpecificationEdition>1.0</S100:encodingSpecificationEdition>
        <S100:productIdentifier>S-124</S100:productIdentifier>
        <S100:productEdition>2.0.0</S100:productEdition>
        <S100:applicationProfile>1</S100:applicationProfile>
        <S100:datasetFileIdentifier>124CA01C_3398_24.GML</S100:datasetFileIdentifier>
        <S100:datasetTitle>Waterway information</S100:datasetTitle>
        <S100:datasetReferenceDate>2024-12-10</S100:datasetReferenceDate>
        <S100:datasetLanguage>eng</S100:datasetLanguage>
        <S100:datasetAbstract>The abstract of the dataset</S100:datasetAbstract>
        <S100:datasetTopicCategory>oceans</S100:datasetTopicCategory>
        <S100:datasetPurpose>base</S100:datasetPurpose>
        <S100:updateNumber>0</S100:updateNumber>
    </S100:DatasetIdentificationInformation>
    <S124:members>
        <S124:NavwarnPreamble gml:id="CCG.S124.CA01.C.3398.24.0">
            <S124:affectedChartPublications>
                <S124:chartAffected>
                    <S124:chartNumber>1313</S124:chartNumber>
                    <S124:editionDate>2025-04-11</S124:editionDate>
                </S124:chartAffected>
                <S124:language>eng</S124:language>
                <S124:publicationAffected>Batiscan au/to Lac Saint-Pierre</S124:publicationAffected>
            </S124:affectedChartPublications>
            <S124:generalArea>
                <S124:locationName>
                    <S124:language>eng</S124:language>
                    <S124:text>Trois-Rivières to Donnacona</S124:text>
                </S124:locationName>
            </S124:generalArea>
            <S124:locality>
                <S124:locationName>
                    <S124:language>eng</S124:language>
                    <S124:text>Port de Bécancour</S124:text>
                </S124:locationName>
            </S124:locality>
            <S124:messageSeriesIdentifier>
                <S124:agencyResponsibleForProduction>Canadian Coast Guard</S124:agencyResponsibleForProduction>
                <S124:interoperabilityIdentifier>urn:mrn:CCG.S124.CA01.C.3398.24</S124:interoperabilityIdentifier>
                <S124:nameOfSeries>C</S124:nameOfSeries>
                <S124:nationality>Canada</S124:nationality>
                <S124:warningNumber>3398</S124:warningNumber>
                <S124:warningType code="1">Local Navigational Warning</S124:warningType>
                <S124:year>2024</S124:year>
            </S124:messageSeriesIdentifier>
            <S124:navwarnTitle>
                <S124:language>eng</S124:language>
                <S124:text>Waterway information</S124:text>
            </S124:navwarnTitle>
            <S124:intService>true</S124:intService>
            <S124:navwarnTypeGeneral code="10">Newly Discovered Dangers</S124:navwarnTypeGeneral>
            <S124:publicationTime>2024-12-10T06:33:37.773</S124:publicationTime>
            <S124:theReferences xlink:href="#CCG.S124.CA01.C.3398.24.1"/>
            <S124:theReferences xlink:href="#CCG.S124.CA01.C.3398.24.2"/>
        </S124:NavwarnPreamble>
        <S124:References gml:id="CCG.S124.CA01.C.3398.24.1">
            <S124:messageSeriesIdentifier>
                <S124:agencyResponsibleForProduction>Canadian Coast Guard</S124:agencyResponsibleForProduction>
                <S124:interoperabilityIdentifier>urn:mrn:CCG.S124.CA01.C.3283.24</S124:interoperabilityIdentifier>
                <S124:nameOfSeries>C</S124:nameOfSeries>
                <S124:nationality>Canada</S124:nationality>
                <S124:warningNumber>2024</S124:warningNumber>
                <S124:warningType code="1">Local Navigational Warning</S124:warningType>
                <S124:year>2024</S124:year>
            </S124:messageSeriesIdentifier>
            <S124:noMessageOnHand>false</S124:noMessageOnHand>
            <S124:referenceCategory code="1">Warning Cancellation</S124:referenceCategory>
            <S124:theWarning xlink:href="#CCG.S124.CA01.C.3283.24"/>
        </S124:References>
        <S124:NavwarnPart gml:id="CCG.S124.CA01.C.3398.24.2">
            <S124:fixedDateRange>
                <S124:dateStart>
                    <S100:date>2024-12-10</S100:date>
                </S124:dateStart>
            </S124:fixedDateRange>
            <S124:warningInformation>
                <S124:information>
                    <S124:language>eng</S124:language>
                    <S124:text>Shallower depth located at:
46 24.279N 072 22.715W, 10.4 metres</S124:text>
                </S124:information>
                <S124:navwarnTypeDetails code="256">Shallow Depth Reported</S124:navwarnTypeDetails>
            </S124:warningInformation>
            <S124:header xlink:href="#CCG.S124.CA01.C.3398.24.0"/>
            <S124:geometry>
                <S100:pointProperty>
                    <S100:Point gml:id="CCG.S124.CA01.C.3398.24.location.1" srsName="https://www.opengis.net/def/crs/EPSG/0/4326" srsDimension="2">
                        <gml:pos srsName="https://www.opengis.net/def/crs/EPSG/0/4326" srsDimension="2">46.404650 -72.378583</gml:pos>
                    </S100:Point>
                </S100:pointProperty>
            </S124:geometry>
        </S124:NavwarnPart>
    </S124:members>
</S124:Dataset>
